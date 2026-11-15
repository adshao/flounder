import type { IncomingHttpHeaders } from "node:http";

/**
 * Browser-facing request boundary for the control plane.
 *
 * A loopback bind is not an authentication boundary by itself: any page the
 * operator's browser has open can send requests to 127.0.0.1, and a DNS-rebound
 * hostname can read the responses. The control plane holds undisclosed findings
 * and can launch runs, so every request is checked for three things before it
 * reaches a route:
 *
 *  1. Host: on a loopback bind the Host header must name a loopback address (or
 *     an operator-allowlisted name). A rebound hostname fails here.
 *  2. Origin: a request that carries an Origin or Sec-Fetch-Site header must be
 *     same-origin with the Host it was sent to. Non-browser clients (CLI, curl,
 *     daemons) send neither header and are unaffected.
 *  3. Content type: a request body must be declared as JSON, which keeps
 *     state-changing requests out of the CORS "simple request" class.
 *
 * Daemon routes are bearer-authenticated and never browser-initiated, so only
 * the Host check applies to them.
 */
export interface RequestBoundaryInput {
  method: string;
  headers: IncomingHttpHeaders;
  /** True when the server socket is bound to a loopback address. */
  loopbackBound: boolean;
  /** True for bearer-authenticated daemon routes. */
  daemonRoute: boolean;
  /** Extra Host names (no port) the operator explicitly allows, e.g. a local reverse-proxy name. */
  allowedHosts?: readonly string[];
}

export type RequestBoundaryDecision = { ok: true } | { ok: false; status: number; error: string };

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function checkRequestBoundary(input: RequestBoundaryInput): RequestBoundaryDecision {
  const hostHeader = singleHeader(input.headers.host);
  const hostName = hostHeader ? hostNameOf(hostHeader) : undefined;

  if (input.loopbackBound) {
    const allowed = hostName !== undefined
      && (isLoopbackName(hostName) || (input.allowedHosts ?? []).some((name) => name.trim().toLowerCase() === hostName));
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: "forbidden: unexpected Host header for a loopback control plane. Use a loopback address, or list the name in FLOUNDER_UI_ALLOWED_HOSTS.",
      };
    }
  }

  if (input.daemonRoute) return { ok: true };

  const fetchSite = singleHeader(input.headers["sec-fetch-site"])?.toLowerCase();
  if (fetchSite === "cross-site") {
    return { ok: false, status: 403, error: "forbidden: cross-site requests to the control plane are not allowed" };
  }

  const origin = singleHeader(input.headers.origin);
  if (origin !== undefined && !isSameOrigin(origin, hostHeader)) {
    return { ok: false, status: 403, error: "forbidden: cross-origin requests to the control plane are not allowed" };
  }

  if (BODY_METHODS.has(input.method.toUpperCase()) && hasBody(input.headers)) {
    const contentType = singleHeader(input.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return { ok: false, status: 415, error: "unsupported media type: request bodies must be sent as application/json" };
    }
  }

  return { ok: true };
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

export function isLoopbackName(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    // "null" (sandboxed/opaque origins) and malformed values are never same-origin.
    return false;
  }
}

function hostNameOf(hostHeader: string): string | undefined {
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

function hasBody(headers: IncomingHttpHeaders): boolean {
  if (headers["transfer-encoding"] !== undefined) return true;
  const length = Number(singleHeader(headers["content-length"]) ?? "0");
  return Number.isFinite(length) && length > 0;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
