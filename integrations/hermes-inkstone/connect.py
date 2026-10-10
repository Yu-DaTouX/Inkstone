"""Run with Hermes' Python to pair; never prints a device token."""
import argparse
import getpass
import json
import os
import re
import tempfile
from pathlib import Path
from client import Client, connection_file, load_connection, normalize_url


def save_connection(path, url, token):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".inkstone-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"url": url, "token": token}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main():
    parser = argparse.ArgumentParser(description="Pair the Hermes Inkstone plugin with the desktop.")
    parser.add_argument("--url", help="Desktop root address, for example http://127.0.0.1:37892")
    parser.add_argument("--name", default="Hermes", help="Revocable device label shown on desktop")
    parser.add_argument("--check", action="store_true", help="Read connection info without pairing or model calls")
    args = parser.parse_args()
    try:
        if args.check:
            url, token = load_connection()
            result = Client(url, token).request("GET", "/info")
            print("Connected to Inkstone." if result.get("ok") else "Connection failed; verify address and device token.")
            return 0 if result.get("ok") else 1
        url = normalize_url(args.url or os.environ.get("INKSTONE_URL") or "http://127.0.0.1:37892")
        code = getpass.getpass("Pairing code shown on Inkstone desktop (6 digits): ").strip()
        if not re.fullmatch(r"\d{6}", code):
            raise ValueError("Pairing code must contain six digits.")
        if not args.name.strip() or len(args.name) > 60:
            raise ValueError("Device name must contain 1-60 characters.")
        result = Client(url, "").request("POST", "/pair", {"code": code, "deviceName": args.name, "kind": "phone"})
        token = result.get("token")
        if not result.get("ok") or not isinstance(token, str) or not token:
            print("Pairing failed. Generate a new code on desktop and check the network.")
            return 1
        save_connection(connection_file(), url, token)
        print("Paired. Connection saved for this Hermes profile; revoke the Hermes device on desktop to disconnect.")
        return 0
    except (ValueError, OSError, EOFError):
        print("Could not configure Inkstone. Check the address, pairing code and connection file permissions.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
