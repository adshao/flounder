// Version the control-plane <-> execution-plane contract independently from the
// package release. Increment this whenever a daemon could otherwise accept a job
// whose meaning or required fields differ across server and daemon versions.
export const DAEMON_PROTOCOL_VERSION = 1;
