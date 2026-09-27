#!/usr/bin/env python3
"""YouTube にアップロードするための認証を行い、token.json を作る (最初に 1 回だけ実行)。

ブラウザが使えるパソコンで実行してください:
    python youtube_auth.py --client-secret client_secret.json --token token.json

サーバーなどブラウザが無い環境では --no-browser を付けると URL が表示されるので、
手元のブラウザで開いて許可してください (表示されたポートへの SSH ポート転送が必要です)。
できた token.json をサーバーの DATA_DIR に置けば、あとは自動で更新されます。
"""

from __future__ import annotations

import argparse
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    # 再生リストに追加するために必要
    "https://www.googleapis.com/auth/youtube",
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--client-secret", default="data/client_secret.json",
                        help="Google Cloud でダウンロードした OAuth クライアントの JSON")
    parser.add_argument("--token", default="data/token.json", help="保存先")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(args.client_secret, SCOPES)
    creds = flow.run_local_server(port=args.port, open_browser=not args.no_browser,
                                  access_type="offline", prompt="consent")
    token = Path(args.token)
    token.parent.mkdir(parents=True, exist_ok=True)
    token.write_text(creds.to_json(), encoding="utf-8")
    print(f"保存しました: {token}")


if __name__ == "__main__":
    main()
