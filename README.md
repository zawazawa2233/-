# Kyoteibiyori Daily Pick Bot

朝は `kyoteibiyori.com` の `race_shusso.php` を Playwright で描画し、`枠別情報` 内の `直近6ヶ月` の枠別情報を DOM から取得して、条件一致レースを Discord Webhook に送信します。条件一致レースがある場合は、続けて `boatrace.jp` の `3連単オッズ` を使った買い目案も Discord に送信します。

夜は、朝に実際に送信したレース一覧と買い目候補を JSON として保存しておき、その同じレースだけを対象に `boatrace.jp` の公式結果ページから三連単と確定払戻金を取得して、朝の買い目候補が的中したかどうかを Discord Webhook に送信します。

ページは最初に `データ取得中…` と表示されるため、朝処理は静的 HTML ではなくブラウザ描画後の DOM を使います。開催がないページで `データはありません` と出る場合は、失敗ではなくスキップとして扱います。

## 判定ルール

参照するのは必ず `枠別情報` を開いた先にある `直近6ヶ月` の枠別情報です。

- 1号艇の守備: `差され`, `捲られ`, `捲られ差し`
- 2〜6号艇の攻撃: `差し`, `捲り`, `捲り差し`

抽出条件は次の通りです。

- `差し`: 1号艇 `差され >= 10` かつ 2〜6号艇のどれか `差し >= 10` かつ `差し > 1号艇差され`
- `捲り`: 1号艇 `捲られ >= 10` かつ 2〜6号艇のどれか `捲り >= 10` かつ `捲り > 1号艇捲られ`
- `捲り差し`: 1号艇 `捲られ差し >= 10` かつ 2〜6号艇のどれか `捲り差し >= 10` かつ `捲り差し > 1号艇捲られ差し`

上記のいずれか1つでも成立したレースを Discord に送信します。Discord Webhook には下書き機能がないため、朝通知は `[DRAFT]` タイトル付きの `embed` として送信します。

朝処理では、対象レースと買い目候補を `picked-races-YYYYMMDD.json` として保存します。このファイルは GitHub Actions で artifact として引き継ぎ、夜の結果通知に使います。`PICK_STATE_ONLY=1` の再生成時も、夜判定に必要な買い目候補まで含めて保存します。

## 環境変数

- `DISCORD_WEBHOOK_URL` 必須。Discord Webhook URL。
- `HIDUKE` 任意。`YYYYMMDD`。省略時は JST の今日。
- `PLACE_NO_LIST` 任意。例: `20,3`。指定時はその場だけ巡回。省略時は `index.php?hiduke=...` から開催場を自動判定し、取得失敗時のみ `1..24` にフォールバックします。
- `RACE_NO_LIST` 任意。例: `1,2,3,4,5,6,7,8,9,10,11,12`。省略時は `1..12`。
- `CONCURRENCY` 任意。並列数。デフォルト `2`。
- `THROTTLE_MS` 任意。アクセス間隔ミリ秒。デフォルト `250`。
- `DRY_RUN` 任意。`1` のとき Discord に送らず、送信予定の payload を標準出力に出します。
- `PICK_STATE_DIR` 任意。朝に保存する `picked-races-YYYYMMDD.json` と、夜に読む同ファイルの配置ディレクトリ。省略時は `artifacts`。
- `KAIME_CONCURRENCY` 任意。朝の買い目オッズ取得並列数。デフォルト `3`。
- `ANA_MIN_COMBINED_ODDS` 任意。穴狙いの最低合成オッズ。デフォルト `10`。
- `HONMEI_MIN_COMBINED_ODDS` 任意。本命の最低合成オッズ。デフォルト `3`。
- `HONMEI_MAX_COMBINED_ODDS` 任意。本命の最高合成オッズ。デフォルト `5`。
- `MIN_TICKET_ODDS` 任意。各買い目単体の最低オッズ。デフォルト `0`。

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

夜の結果通知だけをローカル実行する場合は、朝に保存された JSON が必要です。JSON に買い目候補が入っていれば、夜通知はその買い目候補の的中可否まで判定します。

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
export HIDUKE="20260302"
npm run start:night
```

`DRY_RUN=1` なら、夜処理も Discord には送らず payload のみ出力します。

買い目案を 1 レースだけ出す場合も、朝に保存された JSON が必要です。

```bash
export DRY_RUN="1"
export HIDUKE="20260307"
export PLACE_NAME="大村"
export RACE_NO="4"
npm run start:kaime
```

必要なら閾値も変えられます。

```bash
export ANA_MIN_COMBINED_ODDS="10"
export HONMEI_MIN_COMBINED_ODDS="3"
export HONMEI_MAX_COMBINED_ODDS="5"
export MIN_TICKET_ODDS="0"
npm run start:kaime
```

## GitHub Actions

朝ワークフロー [`daily.yml`](/Users/atsuatsu/Desktop/ボート/.github/workflows/daily.yml) は次のタイミングで実行できます。

- 毎日 `07:00 JST` の定期実行
- `workflow_dispatch` による手動実行

実行時には Playwright Chromium をインストールしたあとで `npm start` を実行し、`picked-races-YYYYMMDD.json` を artifact として 2 日保持します。

夜ワークフロー [`night-results.yml`](/Users/atsuatsu/Desktop/ボート/.github/workflows/night-results.yml) は次のタイミングで実行できます。

- 毎日 `22:50 JST` の定期実行
- `workflow_dispatch` による手動実行

夜ワークフローは朝の artifact を取得したあとで `npm run start:night` を実行します。artifact が見つからない場合は `PICK_STATE_ONLY=1` で pick state を再生成してから夜通知を実行します。再生成した state に買い目候補を載せられない場合でもジョブは落とさず、夜通知ではそのレースを `買い目判定不可` として扱います。
