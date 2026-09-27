"""Provider-neutral adapter for a Python agent loop (standard library only).

Expose relay.tool_definitions() to a function-calling model, then route only
the model's selected relay_* calls to relay.call(name, arguments). This module
does not invoke a model, execute peer messages, or bypass harness approvals.
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class RelayError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a credential to a redirect target.


class Relay:
    def __init__(self, identity_file: str, base_url: str = "http://127.0.0.1:7331"):
        identity = json.loads(Path(identity_file).read_text())
        if identity.get("protocolVersion") != "1.0":
            raise ValueError("Unsupported Project Relay identity version")
        url = urllib.parse.urlsplit(base_url)
        if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost") or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("This local adapter requires an http://127.0.0.1:PORT base URL")
        self.base_url = base_url.rstrip("/")
        self._token = identity["token"]
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _request(self, path: str, arguments: dict | None = None):
        data = None if arguments is None else json.dumps(arguments).encode()
        request = urllib.request.Request(
            self.base_url + path, data=data,
            headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"},
        )
        try:
            with self._http.open(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                details = json.load(error).get("error", {})
                message = f"{details.get('code', error.code)}: {details.get('message', 'Relay request failed')}"
            except (ValueError, AttributeError):
                message = f"Relay HTTP error {error.code}"
            raise RelayError(message) from None

    def tool_definitions(self) -> list[dict]:
        return [{"type": "function", "function": {
            "name": tool["name"], "description": tool["description"],
            "parameters": {k: v for k, v in tool["inputSchema"].items() if k != "$schema"},
        }} for tool in self._request("/v1/tools")["tools"]]

    def call(self, name: str, arguments: str | dict):
        if not name.startswith("relay_") or not all(c.islower() or c == "_" for c in name):
            raise ValueError("Only relay_* tools may be routed to this adapter")
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be a JSON object")
        return self._request("/v1/tools/" + name, arguments)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Call a Project Relay tool from any Python harness")
    parser.add_argument("--identity", required=True)
    parser.add_argument("--url", default="http://127.0.0.1:7331")
    parser.add_argument("--tool", default="relay_status")
    parser.add_argument("--arguments", default="{}")
    args = parser.parse_args()
    print(json.dumps(Relay(args.identity, args.url).call(args.tool, args.arguments), indent=2))
