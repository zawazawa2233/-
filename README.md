# Kyoteibiyori Daily Pick Bot

`kyoteibiyori.com` の `race_shusso.php` を Playwright で描画し、`枠別情報` 内の `直近6ヶ月` の枠別情報をDOMから取得して、条件一致レースを Discord Webhook に送信するスクリプトです。

ページは最初に `データ取得中…` と表示されるため、静的HTMLではなくブラウザ描画後のDOMを使います。
開催がないページで `データはありません` と出る場合は、失敗ではなくスキップとして扱います。

## 判定ルール

参照するのは必ず `枠別情報` を開いた先にある `直近6ヶ月` の枠別情報です。

- 1号艇の守備: `差され`, `捲られ`, `捲られ差し`
- 2〜6号艇の攻撃: `差し`, `捲り`, `捲り差し`

抽出条件は次の通りです。

- `差し`: 1号艇 `差され >= 10` かつ 2〜6号艇のどれか `差し >= 10` かつ `差し > 1号艇差され`
- `捲り`: 1号艇 `捲られ >= 10` かつ 2〜6号艇のどれか `捲り >= 10` かつ `捲り > 1号艇捲られ`
- `捲り差し`: 1号艇 `捲られ差し >= 10` かつ 2〜6号艇のどれか `捲り差し >= 10` かつ `捲り差し > 1号艇捲られ差し`

上記のいずれか1つでも成立したレースを Discord に送信します。Discord Webhook には下書き機能がないため、`[DRAFT]` タイトル付きの `embed` として送信します。

## 環境変数

- `DISCORD_WEBHOOK_URL` 必須。Discord Webhook URL。
- `HIDUKE` 任意。`YYYYMMDD`。省略時は JST の今日。
- `PLACE_NO_LIST` 任意。例: `20,3`。指定時はその場だけ巡回。省略時は `index.php?hiduke=...` から開催場を自動判定し、取得失敗時のみ `1..24` にフォールバックします。
- `RACE_NO_LIST` 任意。例: `1,2,3,4,5,6,7,8,9,10,11,12`。省略時は `1..12`。
- `CONCURRENCY` 任意。並列数。デフォルト `2`。
- `THROTTLE_MS` 任意。アクセス間隔ミリ秒。デフォルト `250`。
- `DRY_RUN` 任意。`1` のとき Discord に送らず、送信予定の payload を標準出力に出します。

## Discord Webhook の作成

1. Discord の対象サーバーで `サーバー設定` を開きます。
2. `連携サービス` から `ウェブフック` を開きます。
3. 新しいウェブフックを作成します。
4. URL をコピーします。

## GitHub Secrets の設定

1. GitHub リポジトリの `Settings` を開きます。
2. `Secrets and variables` -> `Actions` を開きます。
3. `New repository secret` を押します。
4. Name に `DISCORD_WEBHOOK_URL` を設定します。
5. Value に Discord でコピーした Webhook URL を設定します。

`/.github/workflows/daily.yml` は毎日 `07:00 JST` に実行されます。GitHub Actions の cron は UTC なので、設定値は `0 22 * * *` です。

## ローカル実行

```bash
npm install
npx playwright install chromium
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
npm start
```

必要なら追加で環境変数を指定します。

```bash
export HIDUKE="20260302"
export PLACE_NO_LIST="20,3"
export RACE_NO_LIST="1,2,3,4,5,6"
export CONCURRENCY="2"
export THROTTLE_MS="250"
npm start
```

Webhook を使わずに 1場1R だけ試す場合はこうです。

```bash
export DRY_RUN="1"
export HIDUKE="20260302"
export PLACE_NO_LIST="20"
export RACE_NO_LIST="1"
npm start
```

## GitHub Actions

ワークフローは次のタイミングで実行できます。

- 毎日 `07:00 JST` の定期実行
- `workflow_dispatch` による手動実行

実行時には Playwright Chromium をインストールしたあとで `npm start` を実行します。
