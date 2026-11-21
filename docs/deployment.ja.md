# デプロイマニュアル（日本語）

English version: [`deployment.en.md`](deployment.en.md)

このマニュアルは、空の AWS アカウントと新品の Raspberry Pi Zero W から、動く人形までの手順です。
先に AWS 側を行ってください。Pi 側はスタック出力の値を使います。

| 区分 | 実行場所 | 章 |
|---|---|---|
| A. AWS（クラウドとダッシュボード） | 手元の PC から自分の AWS アカウントへ | [A 章](#a-aws-側) |
| B. Raspberry Pi（warashi-agent） | 人形の台座内の Pi Zero W | [B 章](#b-raspberry-pi-側) |

証明書、秘密鍵、`config.toml`、`cdk.context.json`、アカウント ID、ホスト名は絶対にコミットしないでください。
`.gitignore` で除外済みです。

---

## A. AWS 側

### A1. 前提

- 自分の AWS アカウントと、PC 上の認証情報（`aws sts get-caller-identity` が通ること）。
  デプロイするユーザーには広い権限が必要です（CloudFormation、IAM、Lambda、S3、IoT、Cognito、
  CloudFront、Rekognition、SNS、DynamoDB、API Gateway、Budgets）。
- AWS CLI v2、Node.js（現行 LTS）と npm、Python 3.13（補助スクリプト用）。
- リージョンは **`ap-northeast-1`（東京）** 固定です（`cloud/bin/cloud.ts`）。
- 受信できるメールアドレス 2 つ（不審者通知用、予算アラート用）。

### A2. PC 上でコードを確認（AWS 不要）

```
make setup
make test
make lint
```

### A3. CDK コンテキストの設定

```
cd cloud
npm install
cp cdk.context.example.json cdk.context.json     # git 管理外
```

`cdk.context.json` を編集します。

| キー | 必須 | 意味 |
|---|---|---|
| `notificationEmail` | はい | 不審者通知の宛先（SNS メール購読）。 |
| `budgetAmountUsd` | はい | 月額予算（USD、0 より大きい値）。 |
| `budgetEmail` | はい | 予算の 50%、80%、100% で届くアラートの宛先。 |
| `voiceEnabled` | いいえ（既定 `false`） | 音声会話のキルスイッチ。初回は `false` のままにします。 |
| `dashboardUrl` | いいえ | ダッシュボードの URL（出力 `WebUrl`）。初回デプロイ後に設定します（A6）。 |

その他の調整値（`familyMin`、`strangerMax`、`snapshotExpiryDays`、`statusIntervalS`、
`reviewerRealEncounters` など）は任意です。`WARASHI_` で始まる環境変数はコンテキストの値を上書きします。
既定値と範囲は `cloud/lambda/_shared/config.ts` にあります。
必須キーが無い、または不正だと `cdk synth` がキー名つきのエラーで止まります。

### A4. ダッシュボードをビルドしてからデプロイ

`WebStack` は `dashboard/dist` をアップロードします。フォルダが空または無いと、代わりに
プレースホルダーのページが配信されるので、先にビルドします。

```
cd dashboard
npm install
npm run build
cd ../cloud
npx cdk bootstrap          # アカウントとリージョンごとに 1 回
npx cdk diff               # 任意：作成内容の確認
npx cdk deploy --all
```

スタックは依存順に `DataStack`、`JudgementStack`、`ApiStack`、`VoiceStack`、`WebStack` です。
`BudgetStack` は独立しています。すべてに `project=zashiki-warashi` タグが付きます。

スタック出力を控えてください。

| 出力 | 用途 |
|---|---|
| `WebUrl` | ダッシュボードのアドレス。 |
| `ApiUrl`、`UserPoolId`、`UserPoolClientId` | ダッシュボードが `/config.json` で読みます。ユーザー作成にも使います。 |
| `IotEndpoint` | 人形の MQTT エンドポイント（`provision_device.sh` が書き出します）。 |
| `DevicePolicyName` | `provision_device.sh --policy` の引数。 |
| `DataBucketName` | `seed_demo_collection.py --bucket` の引数。 |
| `StrangerTopicArn`、`HouseholdCollectionId`、`DemoCollectionId` | 参考情報。 |
| `VoiceHttpHost`、`VoiceRealtimeHost` | `voiceEnabled` が true のときのみ。 |

あとから再表示するには次を実行します。

```
aws cloudformation describe-stacks --region ap-northeast-1 \
  --query "Stacks[].Outputs[].[OutputKey,OutputValue]" --output text
```

### A5. 通知メールの購読を確認（48 時間以内）

SNS が `notificationEmail` に確認メールを送ります。リンクをクリックしてください。
確認するまで不審者通知は届きません。未確認の購読は 48 時間で失効します。

### A6. `dashboardUrl` を設定して再デプロイ

`JudgementStack` は、`WebStack` から読むと循環依存になるため、ダッシュボード URL をコンテキストから受け取ります。
初回デプロイ後に `WebUrl` の値を `cdk.context.json` に追加して、もう一度デプロイします。

```
"dashboardUrl": "https://<your-cloudfront-domain>"
```
```
npx cdk deploy --all
```

### A7. ユーザーの作成

セルフサインアップは無効です。Cognito ユーザープールにユーザーを作成し、グループに入れます。
パスワードは 12 文字以上で、小文字、大文字、数字を含めます。

```
POOL=<UserPoolId>
aws cognito-idp admin-create-user --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --user-attributes Name=email,Value=<mail> \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --password '<強いパスワード>' --permanent
aws cognito-idp admin-add-user-to-group --region ap-northeast-1 --user-pool-id "$POOL" \
  --username <family-user> --group-name family
```

読み取り専用のデモ用アカウントは `--group-name reviewer` で同様に作成します。
グループ無しのユーザーはアクセスできません。両方に属する場合は `reviewer` が優先されます。

### A8. デモ用コレクションの投入（シミュレーション用）

`POST /simulate` は、自分で用意したサンプル顔写真でのみ動きます。同意を得た顔写真を `<id>.jpg`
として、ID とラベルだけの `manifest.json`（名前は入れない）と一緒に、リポジトリの**外**のフォルダに置きます。

```
pip install boto3
python3 scripts/seed_demo_collection.py --bucket <DataBucketName> --samples-dir <フォルダ>
```

`family` ラベルの写真だけがデモ用コレクションに登録されます。家族用コレクションには触れません。
投入するまでは `POST /simulate` が `validation_failed` を返します。

### A9. キャッシュ音声の生成

PC で実行します（Pi では実行しません）。Amazon Polly を呼び出し、
`device/warashi_agent/voice/lines.toml` の隣にセリフごとの WAV を書き出します。

```
python3 scripts/generate_voice_lines.py [--voice Kazuha] [--region ap-northeast-1]
```

WAV は git 管理外です。B 章の `deploy_pi.sh` が Pi にコピーします。

### A10. クラウドの動作確認

1. `WebUrl` を開き、family ユーザーでサインインして、シミュレーションのシナリオを実行します。
2. `docs/dashboard-owner-checks.md` を順に確認します（デプロイ先からのサインイン、顔写真アップロード、
   iOS の音声、Service Worker、レイアウト、キーボード操作）。
3. 任意：自分のスタックに対する結合テスト（実機ではなく**テスト用 thing** を使うこと）。
   `cd cloud && WARASHI_AWS_INTEGRATION=1 npx vitest --run test/integration`
   （必要な環境変数は `README.md` を参照）。

### A11. 任意：音声会話

既定はオフです。`cdk.context.json` の `voiceEnabled` と、人形の `config.toml` の
`conversation_enabled` の両方をオンにする必要があります。

1. **Lambda 同時実行数のクォータ。** `voice-session` は同時実行数 3 を予約し、Lambda はアカウントごとに
   予約なしの 10 を残す必要があります。既定の上限のままのアカウントは、デプロイ前に
   クォータ引き上げを申請してください（Service Quotas、Lambda、「Concurrent executions」）。
2. **Bedrock のモデルアクセス：** `ap-northeast-1` の `amazon.nova-2-5-sonic` をコンソールで有効にします。
3. `"voiceEnabled": true` にして `npx cdk deploy --all` を実行します。出力に `VoiceHttpHost` と
   `VoiceRealtimeHost` が加わります。
4. Nova 2.5 Sonic は日本語を公式にはサポートしていません。有効化の前に実際に聞いて確かめてください。
   `python3 scripts/check_sonic_japanese.py` と `python3 scripts/check_appsync_ordering.py ...`
   （`README.md` 参照）。品質が不十分なら `voiceEnabled` を `false` に戻します。
5. `scripts/generate_voice_lines.py` を再実行し、2 つの AppSync ホストを付けて人形を再プロビジョニング（B3）し、
   実機テストが通ってから Pi 側で `conversation_enabled = true` にします。

### A12. 更新と削除

- 更新：コードを変更し、ダッシュボードを変えた場合は `dashboard/` で `npm run build`、その後 `npx cdk deploy --all`。
- 削除：`cd cloud && npx cdk destroy --all`。スタックは `RemovalPolicy.DESTROY` のため、
  データバケット、テーブル、顔コレクションも一緒に消えます。`provision_device.sh` が作った IoT の
  thing と証明書はスタックの対象外なので、自分で削除してください。

---

## B. Raspberry Pi 側

### B1. 前提

- `.kiro/steering/hardware.md` のとおりに組み立て、配線済みであること。PIR は GPIO 17、パンのサーボは GPIO 18、
  チルトのサーボは GPIO 13、ランタンの MOSFET ゲートは GPIO 23。サーボと LED は別系統の 4.8 V 電池で、
  グラウンドを Pi と共通にします。AT-CSP1 スピーカーフォンは `USB` ポート（電源は `PWR`）、カメラ接続済み。
- **サーボは 180° のポジショナル型のみ。** 連続回転サーボは首にケーブルを巻き込みます。
- システム Python 3.13 の Raspberry Pi OS を SD カードに書き込み、Wi-Fi 設定、SSH 有効、root 以外の最初のユーザー。
  デプロイスクリプトはパスワード無しの `sudo` を前提にします（そのユーザーの OS 既定）。
- PC 側：Pi への `rsync` と `ssh`（`ssh <user>@<hostname>.local` が通ること）、AWS CLI v2、`curl`（B3 用）。

### B2. Pi に OS パッケージを入れる

エージェントはシステム Python と `apt` のパッケージを使います。Pi で pip は使いません。

```
sudo apt update
sudo apt install python3-gpiozero python3-lgpio python3-paho-mqtt alsa-utils rpicam-apps
# 音声会話を使う場合のみ:
sudo apt install python3-websockets
```

エージェントを動かす前にハードウェアを確認します。`device/tools` を Pi に置き
（`deploy_pi.sh` が `~/warashi/device/tools` に配置したものでも可）、次の順に実行します。

```
python3 warashi_test.py pir      # 電源投入後 30〜60 秒待つ
python3 warashi_test.py servo    # サーボホーンは中心位置で取り付ける
python3 warashi_test.py led
python3 warashi_calib.py pan     # 続けて tilt。結果は ~/warashi_limits.txt に追記される
python3 warashi_check.py         # PIR、サーボ、LED、スピーカー、マイク、カメラ
```

これらのツールは `config.toml` と `motion_enabled` を無視します。詳細と注意事項は
`device/tools/README.md` を参照してください。実行のたびに、頭は手で中心に合わせます。

### B3. AWS IoT Core に人形を登録（PC で実行）

A4 のスタック出力が必要です。`--out` は git 管理下の外にします。

```
scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
    --policy <DevicePolicyName>
# 音声会話を使う場合は次を追加
#   --appsync-realtime-host <VoiceRealtimeHost> --appsync-http-host <VoiceHttpHost>
```

スクリプトは再実行しても安全です。`--rotate` は新しい証明書を発行し、新旧の付け替えが成功してから
古い証明書を無効にします。実行後にコピー用のコマンドが表示されます。例：

```
ssh <user>@<host> 'mkdir -p -m 700 /home/pi/.warashi'
scp ~/warashi-secrets/warashi-01/{device.pem.crt,device.private.key,AmazonRootCA1.pem,warashi-aws.toml} \
    <user>@<host>:/home/pi/.warashi/
```

Pi のユーザー名が `pi` でない場合は `--pi-dir /home/<user>/.warashi` を指定します。

### B4. Pi 上で `config.toml` を作る

`deploy_pi.sh` は `config.toml` をコピーも上書きもしません。Pi 上のサービスの作業ディレクトリ
（既定 `~/warashi/device`）に、最初の 1 回だけ作ります。

```
cp ~/warashi/device/config.example.toml ~/warashi/device/config.toml   # 初回デプロイ（B5）の後
```

編集内容：

1. `~/.warashi/warashi-aws.toml` の `[aws]` テーブル（エンドポイントと証明書のパス）を統合し、
   `enabled = true` にします。
2. キャリブレーション結果を `[servo]` の中心オフセットと可動範囲に反映します。取り付け向きに応じて
   `pan_invert` と `tilt_invert` も設定します。パンは ±60°、チルトは ±30° を超えると読み込みが拒否されます。
3. B7 が通るまで **`motion_enabled = false`** のままにします。false の間、サーボ動作はログに出るだけです。
4. `conversation_enabled` は A11 が完了するまでオフのままにします。

### B5. エージェントのデプロイ（PC から）

**前提：A9 でキャッシュ音声（WAV）を生成済みであること。** `device/warashi_agent/voice/` に WAV が無い状態でデプロイすると、
人形は声を出せず、起動時に `voice_file_missing` が出ます。デプロイ前に次で確認してください。

```
ls device/warashi_agent/voice/*.wav | wc -l     # lines.toml のセリフ数（現在 13）と同じであること
```

```
PI_HOST=<user>@<hostname>.local scripts/deploy_pi.sh     # または make deploy
# 任意: PI_DIR=~/warashi/device（既定）
```

スクリプトは rsync で `device/` をコピーします（`--delete` は使わず、`config.toml`、`.venv`、キャッシュ、
`last_pose.json` は除外。生成済み WAV は含まれます）。次に実際のユーザーとパスで
`/etc/systemd/system/warashi-agent.service` を作成し、有効化して再起動します。最初に失敗した手順の名前を
表示して止まります。初回デプロイなら、ここで B4 を行ってからもう一度実行します。

### B6. 接続とエージェントの確認

Pi 上の `~/warashi/device` で実行します。

```
python3 tools/check_cloud.py          # PASS、または「FAIL <手順>」とヒントを表示
python3 -m warashi_agent --selftest   # 各アダプターを 1 回ずつ: PASS、FAIL、SKIP
systemctl status warashi-agent
journalctl -u warashi-agent -f
```

起動ログに `voice_file_missing` や `voice_line_invalid` が無いことも確認します（キャッシュ音声の不足を示します）。

`check_cloud.py` は `cloud.connected` とコマンドの受信を待ちます。待っている間にダッシュボードから
何かコマンドを送ってください。接続に失敗したら、まず Pi の時刻（`timedatectl`）、次に証明書のパスを確認します。
Pi が動いているのにサーボと LED が反応しないときは、電池ボックスを疑ってください。
音声デバイスが見つからないときは、電源ケーブルと OTG アダプターが `PWR` と `USB` で入れ替わっていないか確認します。

### B7. 動作（モーション）を有効にする

頭を手で中心に合わせ、首まわりにケーブルの引っかかりが無く、電池が確実に収まっていることを確認して、
`config.toml` の `motion_enabled = true` にします。その後：

```
sudo systemctl restart warashi-agent
```

起動後 `pir_warmup_s`（60 秒）の間は PIR が無視されます。人形の前を歩くと、ランタンが灯り、頭がゆっくり向き、
その出来事がダッシュボードのタイムラインに出ます。回りすぎる、回り続けるなどの異常があれば、
すぐに `sudo systemctl stop warashi-agent` で止めてください。

### B8. 運用と更新

| 作業 | コマンド |
|---|---|
| エージェントの更新 | `PI_HOST=... scripts/deploy_pi.sh` |
| 音声の追加・変更 | `scripts/generate_voice_lines.py` の後に `deploy_pi.sh` |
| ログ | `journalctl -u warashi-agent -f` |
| 停止・起動 | `sudo systemctl stop warashi-agent` / `sudo systemctl start warashi-agent` |
| 証明書のローテーション | `scripts/provision_device.sh ... --rotate`、ファイルをコピー、再起動 |
| ハードウェア無しで実行 | PC で `make fake` |

サービスは SIGTERM を受けるとサーボを切り離してランタンを消します。中心へ戻る動きはしません。

---

## トラブルシューティング

| 症状 | 考えられる原因 |
|---|---|
| `cdk synth` がコンテキストのキー名を出して止まる | `cdk.context.json` の必須キーが無い、または不正。 |
| ダッシュボードに "has not been built yet" と出る | デプロイ時に `dashboard/dist` が空だった。`npm run build` して再デプロイ。 |
| 不審者メールが来ない | SNS の購読が未確認（A5）。 |
| `VoiceStack` のデプロイが失敗する | Lambda 同時実行数のクォータ不足（A11）。 |
| `provision_device.sh` が `--out` を拒否する | フォルダが git 管理下にある。別の場所にする。 |
| `deploy_pi.sh: step 'user query' failed` | SSH ユーザーが root、または SSH の失敗。通常ユーザーを使う。 |
| 人形が「誰かいるの？」のセリフしか言わない | クラウド接続が切れている。`check_cloud.py` を実行。オフラインでも基本動作は続く設計。 |
| 起動時に `voice_file_missing` / `voice_line_invalid` が出る、声が出ない | キャッシュ音声が未生成、またはコピーされていない。A9 を実行して B5 をやり直す。Pi 側は `~/warashi/device/warashi_agent/voice/` に WAV があるか確認。 |
| サーボのログは出るが動かない | `motion_enabled` がまだ `false`。 |
