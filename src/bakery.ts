/* Copyright (C) 2018 Canonical Ltd. */

/**
 * bakeryjs.
 * @module bakeryjs
 * @example
 * ```js
 * import { Bakery } from "@canonical/macaroon-bakery";
 * const bakery = new Bakery();
 *
 * bakery.get(url, headers, callback)
 * ```
 */

import macaroonlib, {
  Macaroon,
  Error as MacaroonError,
  MacaroonObject,
} from "macaroon";
import util from "util";

export type BakeryRequestHeaders = Record<string, string>;

export type BakeryRequestBody =
  | Document
  | XMLHttpRequestBodyInit
  | null
  | undefined;

export type BakeryResponse = ProgressEvent<XMLHttpRequest>;

export type BakeryRequestCallback = (
  error: string | MacaroonError | null,
  response: BakeryResponse | null
) => void;

export interface BakeryStore {
  getItem(key: string): string;
  setItem(key: string, value: string): void;
  clear(): void;
}

export type VisitPageInfo = {
  WaitURL: string;
  VisitURL: string;
};

// Define the default bakery protocol version.
const DEFAULT_PROTOCOL_VERSION = 2;
// Define the HTTP content type for JSON and encoded form requests.
const JSON_CONTENT_TYPE = "application/json";
const WWW_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
// Define HTTP statuses.
const STATUS_UNAUTHORIZED = 401;
const STATUS_PROXY_AUTH_REQUIRED = 407;
// Define bakery specific errors.
const ERR_DISCHARGE_REQUIRED = "macaroon discharge required";
const ERR_INTERACTION_REQUIRED = "interaction required";

let LocalTextDecoder: typeof util.TextDecoder | typeof window.TextDecoder;
if (typeof window !== "undefined" && window && window.TextDecoder) {
  LocalTextDecoder = window.TextDecoder;
} else {
  // No window.TextDecoder if it's node.js.
  LocalTextDecoder = util.TextDecoder;
}

/**
  Serialize the given macaroons.

  @param macaroons The macaroons to be serialized.
  @return The resulting serialized string.
*/
const serialize = (macaroons: MacaroonObject[]) => {
  return btoa(JSON.stringify(macaroons));
};

/**
  De-serialize the given serialized macaroons.

  @param serialized The serialized macaroons.
  @return The resulting macaroon slice.
*/
const deserialize = (serialized: string): MacaroonObject => {
  return JSON.parse(atob(serialized));
};

/**
  A macaroon bakery implementation.

  The bakery implements the protocol used to acquire and discharge macaroons
  over HTTP.
*/
class Bakery {
  _dischargeDisabled: boolean;
  _onSuccess: () => void;
  _protocolVersion: number;
  _sendRequest: (
    path: string,
    method: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    withCredentials: boolean,
    callback?: (event: BakeryResponse) => void
  ) => XMLHttpRequest;
  _visitPage: (error: { Info: VisitPageInfo }) => void;
  storage: InstanceType<typeof BakeryStorage>;

  /**
    Initialize a macaroon bakery with the given parameters.

    @param config - optional config.
    @param config.onSuccess - a function to be called when the
      request completes properly.
    @param config.protocolVersion - the macaroon protocol version
      that the bakery should use.
    @param config.storage - the storage used to persist macaroons.
      It must implement the following interface:
    @param config.storage.get - get(key) -> value.
    @param config.storage.set - set(key, value, callback): the
      callback is called without arguments when the set operation has been
      performed. If not provided, it defaults to BakeryStorage using an in
      memory store.
    @param config.visitPage - the function used to visit the identity
      provider page when required, defaulting to opening a pop up window. It
      receives an error object.
    @param config.visitPage.Info - an object containing relevant info
      for the visit handling.
    @param config.visitPage.Info.WaitURL - the url to wait on for IdM
      discharge.
    @param config.visitPage.Info.VisitURL - the url to visit to
      authenticate with the IdM.
    @param config.visitPage.jujugui - an optional value specifying a
      method to use against idm to authenticate. Used in non interactive
      authentication scenarios.
    @param config.sendRequest -  a function used to make XHR HTTP
      requests, with the following signature: func(path, method, headers, body,
      withCredentials, callback) -> xhr. By default an internal function is
      used. This is mostly for testing.
  */
  constructor(params?: {
    onSuccess?: Bakery["_onSuccess"];
    sendRequest?: Bakery["_sendRequest"];
    storage?: Bakery["storage"];
    visitPage?: Bakery["_visitPage"];
    protocolVersion?: Bakery["_protocolVersion"];
  }) {
    this._onSuccess = params?.onSuccess || (() => {});
    this._sendRequest = params?.sendRequest || _request;
    this.storage = params?.storage || new BakeryStorage(new InMemoryStore());
    this._visitPage =
      params?.visitPage ||
      ((error) => {
        window.open(error.Info.VisitURL, "Login");
      });
    this._dischargeDisabled = false;
    this._protocolVersion = params?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
  }

  /**
    Send an HTTP request to the given URL with the given HTTP method, headers
    and body. The given callback receives an error and a response when the
    request is complete.

    @param url The URL to which to send the request.
    @param method The HTTP method, like "get" or "POST".
    @param headers Headers that must be included in the request.
      Note that bakery specific headers are automatically added internally.
    @param body The request body if it applies, or null.
    @param callback A function called when the response is
      received from the remote URL. It receives a tuple (error, response).
      If the request succeeds the error is null.
    @return the XHR instance.
  */
  sendRequest(
    url: string,
    method: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ): XMLHttpRequest {
    method = method.toLowerCase();
    // Prepare the send method and wrap the provided callback.
    const wrappedCallback = this._wrapCallback(
      url,
      method,
      headers,
      body,
      callback
    );
    // Prepare the header. Include already stored macaroons in the header if
    // present for the current URL.
    const allHeaders: BakeryRequestHeaders = {
      "Bakery-Protocol-Version": this._protocolVersion.toString(),
    };
    const macaroons = this.storage.get(url);
    if (macaroons) {
      allHeaders["Macaroons"] = macaroons;
    }
    Object.keys(headers || {}).forEach((key) => {
      const value = headers[key];
      allHeaders[key] = value;
    });
    // Prepare the parameters for sending the HTTP request.
    // The only time we need the with credentials header is for cookie auth;
    // it's not pretty, but special casing here is the most direct solution.
    // Another option is to implement a factory method on bakery, e.g.
    // bakery.withCredentials(), which would return a bakery that sets the
    // withCredentials param to true rather than false.
    let withCredentials = false;
    if (method === "put" && url.indexOf("/set-auth-cookie") !== -1) {
      withCredentials = true;
    }
    // Send the request.
    return this._sendRequest(
      url,
      method,
      allHeaders,
      body,
      withCredentials,
      wrappedCallback
    );
  }

  /**
    Send an HTTP GET request to the given URL with the given headers.
    The given callback receives an error and a response when the request is
    complete.

    See the "sendRequest" method above for a description of the parameters.
  */
  get(
    url: string,
    headers: BakeryRequestHeaders,
    callback: BakeryRequestCallback
  ) {
    return this.sendRequest(url, "get", headers, null, callback);
  }

  /**
    Send an HTTP DELETE request to the given URL with the given headers and
    body. The given callback receives an error and a response when the
    request is complete.

    See the "sendRequest" method above for a description of the parameters.
  */
  delete(
    url: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ) {
    return this.sendRequest(url, "delete", headers, body, callback);
  }

  /**
    Send an HTTP POST request to the given URL with the given headers and
    body. The given callback receives an error and a response when the
    request is complete.

    See the "sendRequest" method above for a description of the parameters.
  */
  post(
    url: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ) {
    return this.sendRequest(url, "post", headers, body, callback);
  }

  /**
    Send an HTTP PUT request to the given URL with the given headers and
    body. The given callback receives an error and a response when the
    request is complete.

    See the "sendRequest" method above for a description of the parameters.
  */
  put(
    url: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ) {
    return this.sendRequest(url, "put", headers, body, callback);
  }

  /**
    Send an HTTP PATCH request to the given URL with the given headers and
    body. The given callback receives an error and a response when the
    request is complete.

    See the "sendRequest" method above for a description of the parameters.
  */
  patch(
    url: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ) {
    return this.sendRequest(url, "patch", headers, body, callback);
  }

  /**
    Discharge the given macaroon. Acquire any third party discharges.

    @param macaroon The decoded macaroon to be discharged.
    @param onSuccess The function to be called if the
      discharge succeeds. It receives the resulting macaroons array.
    @param onFailure The function to be called if the
      discharge fails. It receives an error message.
  */
  discharge(
    macaroon: MacaroonObject,
    onSuccess: (macaroon: MacaroonObject[]) => void,
    onFailure: (message: string | MacaroonError) => void
  ) {
    try {
      macaroonlib.dischargeMacaroon(
        macaroonlib.importMacaroons(macaroon)[0],
        this._getThirdPartyDischarge.bind(this),
        (discharges) => {
          onSuccess(discharges.map((m) => m.exportJSON()));
        },
        onFailure
      );
    } catch (exc: any) {
      onFailure(`discharge failed: ${exc?.message ?? ""}`);
    }
  }

  /**
    Wrap the given callback function so that "discharge required" and
    "interaction required" errors in the response are internally handled.

    See the "sendRequest" method above for a description of the parameters.

    @private
    @return A callable accepting an HTTP response.
  */
  _wrapCallback(
    url: string,
    method: string,
    headers: BakeryRequestHeaders,
    body: BakeryRequestBody,
    callback: BakeryRequestCallback
  ) {
    return (response: BakeryResponse) => {
      // This is the bakery exit point when everything goes well there is
      // nothing to be done further.
      const exitSuccessfully = (resp: BakeryResponse) => {
        callback(null, resp);
        this._onSuccess();
      };
      const error = this._getError<VisitPageInfo>(response.target);
      if (!error) {
        // No discharge or interaction required.
        exitSuccessfully(response);
        return;
      }
      if (typeof error === "string") {
        callback(error, null);
        return;
      }
      // At this point we must either discharge or make the user interact.
      let onSuccess;
      const onFailure = (msg: string | MacaroonError) => {
        callback(msg, null);
      };
      switch (error.Code) {
        case ERR_INTERACTION_REQUIRED:
          onSuccess = (resp: BakeryResponse) => {
            // Once the interaction is done, store any resulting macaroons
            // and then exit successfully. From now on, the stored macaroons
            // will be reused and included in all requests to the same URL.
            const jsonResponse = JSON.parse(resp.target?.responseText ?? "");
            const macaroons = serialize(jsonResponse.Macaroon);
            this.storage.set(url, macaroons, () => {
              if (jsonResponse.DischargeToken) {
                const token = serialize(jsonResponse.DischargeToken);
                this.storage.set(url, token, () => {
                  // Also set this token with a fixed "identity" key so that
                  // it is easy to inject the identity token from an external
                  // system, like OpenStack Horizon/Keystone.
                  this.storage.set("identity", token, () => {
                    exitSuccessfully(resp);
                  });
                });
                return;
              }
              exitSuccessfully(resp);
            });
          };
          this._interact(error, onSuccess, onFailure);
          break;
        case ERR_DISCHARGE_REQUIRED:
          // In the case discharge has been disabled in this bakery instance
          // (see the withoutDischarge method above) just return here.
          if (this._dischargeDisabled) {
            callback("discharge required but disabled", response);
            return;
          }
          onSuccess = (macaroons: MacaroonObject[]) => {
            // Once the discharge is acquired, store any resulting macaroons
            // and then retry the original requests again. This time the
            // resulting macaroons will be properly included in the request
            // header.
            this.storage.set(url, serialize(macaroons), () => {
              this.sendRequest(url, method, headers, body, callback);
            });
          };
          this.discharge(error.Info.Macaroon, onSuccess, onFailure);
          break;
        default:
          // An unexpected error has been encountered.
          callback(this._getErrorMessage(error), null);
          break;
      }
    };
  }

  /**
    Obtain a discharge macaroon for the given third party location.

    @private
    @param location The origin location.
    @param thirdPartyLocation The third party location where to
      discharge.
    @param condition The caveat to be discharged.
    @param onSuccess A function that will be called with the
      discharge macaroon when the acquisition is successfully completed.
    @param onFailure A function that will be called with an error
      message when the third party discharge fails.
  */
  _getThirdPartyDischarge(
    location: string | undefined,
    thirdPartyLocation: string | undefined,
    condition: Uint8Array | undefined,
    onSuccess: (macaroon: Macaroon) => void,
    onFailure: (message: string | MacaroonError) => void
  ) {
    const url = thirdPartyLocation + "/discharge";
    const headers = { "Content-Type": WWW_FORM_CONTENT_TYPE };
    // convert condition to ascii from uint8array
    const caveatString = new LocalTextDecoder("utf-8").decode(condition);
    const encodedCondition = encodeURIComponent(caveatString);
    const encodedLocation = location ? encodeURIComponent(location) : "";
    const body = `id=${encodedCondition}&location=${encodedLocation}`;
    const callback: BakeryRequestCallback = (err, response) => {
      if (err) {
        onFailure(err);
        return;
      }
      let jsonResponse: { Macaroon: MacaroonObject } | null;
      try {
        // It's possible that the response is empty or invalid because of
        // invalid certs, or 500's, etc.
        jsonResponse = JSON.parse(response?.target?.responseText ?? "");
      } catch (e) {
        onFailure("unable to parse macaroon.");
        return;
      }
      if (!jsonResponse) {
        onFailure("unable to parse macaroon.");
        return;
      }
      const macaroons = macaroonlib.importMacaroons(jsonResponse.Macaroon)[0];
      onSuccess(macaroons);
    };
    // Use the bakery itself to get the third party discharge, so that we
    // support recursive discharge requests.
    this.post(url, headers, body, callback);
  }

  /**
    Interact to be able to acquire authentication macaroons.

    @private
    @param visitURL The URL that must be visited to authenticate.
    @param waitURL The URL where to wait for the authentication to
      be completed, and that will eventually provide the authentication
      macaroons and the discharge token.
    @param onSuccess The function that will be called with the
      macaroon when the acquisition succeeds.
    @param onFailure The function that will be called with an
      error string when the acquisition fails.
  */
  _interact(
    error: MacaroonError<VisitPageInfo>,
    onSuccess: (response: BakeryResponse) => void,
    onFailure: (message: string) => void
  ) {
    this._visitPage(error);
    const generateRequest = (callback: (response: BakeryResponse) => void) => {
      const headers = { "Content-Type": JSON_CONTENT_TYPE };
      const body = undefined;
      const withCredentials = false;
      return this._sendRequest(
        error.Info.WaitURL,
        "get",
        headers,
        body,
        withCredentials,
        callback
      );
    };
    // When performing a "wait" request for the user logging into identity
    // it is possible that they take longer than the server timeout of
    // 1 minute: when this happens the server just closes the connection.
    let retryCounter = 0;
    const retryCallback = (response: BakeryResponse) => {
      const target = response.target;
      if (
        target?.status === 0 &&
        target?.response === "" &&
        target?.responseText === ""
      ) {
        // Server closed the connection, retry and increment the counter.
        if (retryCounter < 5) {
          retryCounter += 1;
          generateRequest(retryCallback);
          return;
        }
        // We have retried 5 times so fall through to call handler.
      }
      const error = this._getError(target);
      if (error) {
        // The interaction failed.
        onFailure("cannot interact: " + this._getErrorMessage(error));
        return;
      }
      // The interaction succeeded.
      onSuccess(response);
    };
    generateRequest(retryCallback);
  }

  /**
    Return any error present in the given response.

    @private
    @param target The XHR response.target.
    @return The error as found in the request.
  */
  _getError<I = void>(
    target: XMLHttpRequest | null
  ): string | MacaroonError<I> | null {
    // Check bakery statuses.
    if (
      target?.status !== STATUS_UNAUTHORIZED &&
      target?.status !== STATUS_PROXY_AUTH_REQUIRED
    ) {
      return null;
    }
    // Bakery protocol errors always have JSON payloads.
    if (target?.getResponseHeader("Content-Type") !== JSON_CONTENT_TYPE) {
      return null;
    }
    // At this point it should be possible to decode the error response.
    let error;
    try {
      error = JSON.parse(target.responseText);
    } catch (err) {
      return "cannot parse error response";
    }
    return error;
  }

  /**
    Try to parse the given JSON decoded response in order to retrieve a
    human friendly error.

    @private
    @param jsonResponse The JSON decoded response text.
    @return The error message.
  */
  _getErrorMessage(
    jsonResponse:
      | string
      | {
          Message?: string;
          message?: string;
          error?: string;
          Error?: string;
        }
  ) {
    let error = "";
    if (typeof jsonResponse === "string") {
      return error;
    }
    return (
      jsonResponse?.Message ||
      jsonResponse?.message ||
      jsonResponse?.Error ||
      jsonResponse?.error ||
      "unexpected error: " + JSON.stringify(jsonResponse)
    );
  }
}

/**
  A storage for the macaroon bakery.

  The storage is used to persist macaroons.
*/
class BakeryStorage {
  _store: BakeryStore;
  _services: Record<string, string>;
  _charmstoreCookieSetter:
    | ((value: MacaroonObject, callback: BakeryRequestCallback) => void)
    | null;
  /**
    Initialize a bakery storage with the given underlaying store and params.

    @param store A store object implement the following interface:
      - getItem(key) -> value;
      - setItem(key, value);
      - clear().
    @param config - Optional configuration.
    @param config.initial - a map of key/value pairs that must be
      initially included in
    @param config.services - a map of service names (like "charmstore"
      or "terms") to the base URL of their corresponding API endpoints. This is
      used to simplify and reduce the URLs passed as keys to the storage.
    @param config.charmstoreCookieSetter - a function that can be
      used to register macaroons to the charm store service. The function
      accepts a value and a callback, which receives an error and a response.
  */
  constructor(
    store: BakeryStorage["_store"],
    params?: {
      charmstoreCookieSetter?: BakeryStorage["_charmstoreCookieSetter"];
      initial?: Record<string, string>;
      services?: BakeryStorage["_services"];
    }
  ) {
    this._store = store;
    this._services = params?.services || {};
    this._charmstoreCookieSetter = params?.charmstoreCookieSetter || null;
    const initial = params?.initial || {};
    Object.keys(initial).forEach((key) => {
      const value = initial[key];
      if (value) {
        this.set(key, value);
      }
    });
  }

  /**
    Retrieve and return the value for the provided key.

    @param key The storage key, usually a URL.
    @return The corresponding value, usually a serialized macaroon.
  */
  get(key: string) {
    key = this._getKey(key);
    return this._store.getItem(key);
  }

  /**
    Store the given value in the given storage key.

    Call the callback when done.

    @param key The storage key, usually a URL.
    @param value The value, usually a serialized macaroon.
    @param callback A function called without arguments when the
      value is properly stored.
  */
  set(key: string, value: string, callback?: (() => void) | null) {
    key = this._getKey(key);
    this._store.setItem(key, value);
    if (key === "charmstore" && this._charmstoreCookieSetter) {
      // Set the cookie so that images can be retrieved from the charm store.
      const macaroons = deserialize(value);
      this._charmstoreCookieSetter(macaroons, (err, resp) => {
        if (err) {
          console.error("cannot set charm store cookie:", err);
        }
        callback?.();
      });
      return;
    }
    callback?.();
  }

  /**
    Remove all key/value pairs from the storage.
  */
  clear() {
    this._store.clear();
  }

  /**
    Turn the given key (usually a URL) into a more friendly service name,
    when possible. This also means that different endpoints of the same
    service are reduced to the same service name key, which is ok given that
    all our services use the same macaroon root id for all endpoints.

    If the given key is not a URL, then return it untouched, so that it is
    still possible to set arbitrary keys in the storage. For instance, it is
    surely useful to be able to set or retrieve a service macaroon by using
    its corresponding service name (and not necessarily a URL).

    @private
    @param key The original key.
    @return A possibly simplified/reduced key.
  */
  _getKey(key: string) {
    // If this is one of the external services known by the GUI, such as
    // the charm store or terms, flat out the key to the service name.
    for (const service in this._services) {
      const baseURL = this._services[service];
      if (key.indexOf(baseURL) === 0) {
        return service;
      }
    }
    // If the endpoint ends with "/discharge", remove the suffix, which is
    // usally added back by bakery by convention.
    const suffix = "/discharge";
    if (key.slice(-suffix.length) === suffix) {
      return key.slice(0, -suffix.length);
    }
    return key;
  }
}

/**
  An in-memory store for the BakeryStorage.
*/
class InMemoryStore implements BakeryStore {
  _items: Record<string, string>;
  constructor() {
    this._items = {};
  }
  getItem(key: string) {
    return this._items[key];
  }
  setItem(key: string, value: string) {
    this._items[key] = value;
  }
  clear() {
    this._items = {};
  }
}

/**
  Create, set up and send an asynchronous request to the given path/URL with
  the given method and parameters.
  @private
  @param  path The remote target path/URL.
  @param  method The request method (e.g. "GET" or "POST").
  @param  headers Additional request headers as key/value pairs.
  @param  body The data to send as a file object, a string or in
    general as an ArrayBufferView/Blob object.
  @param  withCredentials Whether to include credentials.
  @param  callback The load event callback.
  @return The xhr asynchronous request instance.
*/
function _request(
  path: string,
  method: string,
  headers: BakeryRequestHeaders,
  body: BakeryRequestBody,
  withCredentials: boolean,
  callback?: (event: BakeryResponse) => void
): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  // Set up the event handlers.
  const handler = (evt: ProgressEvent<XMLHttpRequestEventTarget>) => {
    if (callback) {
      // For some reason the full event type is lost so we must cast it back to
      // XMLHttpRequest (which extends XMLHttpRequestEventTarget which is what
      // the addEventListener event is typed as).
      callback(evt as BakeryResponse);
    }
    // The request has been completed: detach all the handlers.
    xhr.removeEventListener("error", handler);
    xhr.removeEventListener("load", handler);
  };
  xhr.addEventListener("error", handler, false);
  xhr.addEventListener("load", handler, false);
  // Set up the request.
  xhr.open(method, path, true);
  Object.keys(headers || {}).forEach((key) => {
    xhr.setRequestHeader(key, headers[key]);
  });
  if (withCredentials) {
    xhr.withCredentials = withCredentials;
  }
  xhr.send(body || undefined);
  return xhr;
}

export { Bakery, BakeryStorage, InMemoryStore };
