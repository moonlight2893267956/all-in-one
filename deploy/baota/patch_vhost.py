#!/usr/bin/env python3
"""
Patch a 宝塔 nginx vhost to add the mcp-all-in-one location block.

Usage (on the server):
  sudo python3 deploy/baota/patch_vhost.py \\
      --vhost /www/server/panel/vhost/nginx/nps.yunmiao.site.conf \\
      --port 3030 \\
      --location-block deploy/baota/mcp-location-block.conf

It will:
  1) make a .bak.<timestamp> backup
  2) insert the contents of the location block file just BEFORE the
     first  'location / {'  in the vhost
  3) print a diff preview, then run `sudo nginx -t`

Re-run safely: if the marker is already present, the script exits 0.
"""

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

MARKER_START = "# === MCP All-in-One (inserted by deploy) ==="
MARKER_END = "# === /MCP All-in-One ==="


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vhost", required=True, type=Path)
    ap.add_argument("--port", type=int, default=3030)
    ap.add_argument("--location-block", required=True, type=Path)
    args = ap.parse_args()

    vhost = args.vhost
    conf = vhost.read_text()

    if MARKER_START in conf:
        print(f"[skip] marker already present in {vhost}")
        return 0

    block = args.location_block.read_text()
    block = re.sub(r"127\.0\.0\.1:\d+", f"127.0.0.1:{args.port}", block)

    pattern = r"(    location / \{[^}]*\}\n)"
    m = re.search(pattern, conf)
    if not m:
        print(f"[error] no 'location / {{...}}' block found in {vhost}", file=sys.stderr)
        return 1

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = vhost.with_suffix(vhost.suffix + f".bak-{ts}")
    backup.write_text(conf)
    print(f"[backup] {backup}")

    new = conf[: m.start()] + block + conf[m.start() :]
    vhost.write_text(new)
    print(f"[patched] inserted at offset {m.start()}")

    result = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    print(result.stdout)
    print(result.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
