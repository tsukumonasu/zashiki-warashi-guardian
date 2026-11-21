# Zashiki-Warashi Guardian（座敷わらしガーディアン）

English: [README.md](README.md)

> 人が近づくと目を覚まし、ランタンを灯し、ゆっくり振り向いて見つめる日本の伝統人形。
> 家族には挨拶をし、見知らぬ人には不気味に振る舞い、家族に知らせます。

<!-- photo or GIF of the doll here -->

**[ライブダッシュボード →](#)** <!-- replace with the deployed URL before submission -->

---

## 審査員向けクイックスタート

シミュレーションは**ハードウェアもアカウントも不要**です。ブラウザ上の仮想の人形が、実機と同じメッセージを
同梱のサンプル応答で実行します。初回の読み込み後はオフラインでも動きます。4 つのシナリオを合わせても
**2 分以内**（人形の時間で約 62 秒）です。
下のサインインは任意で、Live cloud スイッチが使えるようになるだけです。デモ用アカウントは**読み取り専用**で、
実機の人形を動かしたり喋らせたりできず、顔の管理もできず、実際のスナップショットも見られません。
デモ用の認証情報は、このファイルではなく Devpost の提出文にあります。

### シミュレーション（サインイン不要）

1. 上のダッシュボード URL を開き、**Enter the house** をクリックします。
2. 音は既定でオンで、最初のシナリオをクリックした後に鳴り始めます。ヘッダーの **Mute sound** はいつでも使えます。
   すべてのセリフには日本語テキストと英語字幕が表示されるので、消音でもシナリオを理解できます。
3. **Call a visitor** の下で、シナリオのボタンを 1 つクリックします。実行中はボタンが無効になります。
   **Stop** で途中終了できます。

| クリック | 見えるもの |
|---|---|
| **A family member comes home**（家族が帰ってくる） | 状態が Waking、Looking for someone、Gazing、Greeting、Settling down、Sleeping と進みます。ランタンが灯り、頭が訪問者の方へゆっくり向き、判定は **Family**、日本語の温かい挨拶と英語字幕が出ます。シミュレーションの訪問がタイムラインに追加されます。約 14 秒。 |
| **A stranger enters at night**（夜に見知らぬ人が入ってくる） | 人形が目を覚まして無言で見つめ、その後ささやきます（字幕はそのときだけ出ます）。判定は **Stranger**。タイムラインの項目に **Family notified** と「(simulated, nothing was sent)」（模擬。実際には何も送っていません）と出ます。約 17 秒。 |
| **Something moves, but no one is there**（何かが動くが誰もいない） | 人形は何度か見回して誰も見つけません。判定は **No face**、その後に慎重な「誰かいるの？」のセリフ。約 20 秒。 |
| **The network is down**（ネットワーク断） | クラウドもスナップショットも無いまま、ランタン、視線、キャッシュ済みのセリフで反応します。判定は **Offline**。約 11 秒。 |

4. ナビゲーションの **Timeline** を開きます。実行したものは **Simulated visits** に新しい順に並びます。
   1 つ選ぶと、イベントが時系列で表示されます。

### Live cloud（デモ用サインイン）

1. 最初の画面で **Sign in** をクリックし、Devpost の文章にあるデモ用のユーザー名とパスワードを入力して
   **Sign in** をクリックします。ヘッダーに **Reviewer** と表示されます。
2. **Enter the house** をクリックし、**Live cloud** をオンにします。既定ではオフです。
3. 任意で **Generate a new line** にチェックを入れると、クラウドが新しいセリフを作ります。
4. シナリオのボタンをクリックします。シナリオは本物のバックエンド（顔検索と音声）に問い合わせ、その答えを
   同じ仮想の人形で実行します。各ステップの時間には **Durations measured in the browser** と表示されます。
   **Simulated visits** の項目には **Live cloud** の印が付きます。
   **The network is down** はクラウドを呼ばず、「No cloud call: the network is down」と表示します。
5. クラウドが混んでいると「The cloud needs a rest. Try again in N seconds.」と表示され、10 秒以内に応答が無いと
   「The cloud did not answer」と表示されます。**Run in Simulation mode** をクリックすると、クラウド無しで続けられます。
   失敗した実行はタイムラインに残りません。
6. 実機の人形に関わる領域（操作、顔の登録）には「This is someone's home」と表示され、ロックされたままです。
   **Real visits** の一覧にはスナップショットの代わりにイラストが表示されます。
7. 終わったら **Sign out** をクリックします。

## 開発

```
make setup   # device/.venv（Python 3.13）を作り、pytest、Hypothesis、ruff を入れる
make test
make lint
```

---

## これは何か

Kiroween 2026 の **Frankenstein** 部門への応募作品です。日本の伝統的な工芸人形 × Raspberry Pi Zero W ×
生成 AI を、1 つのメッセージ契約でつなぎました。
システムは、1 つのスキーマ（`docs/schema.md`）を共有する 3 つの部分でできています。

| 部分 | 説明 |
|---|---|
| `device/` | 人形の台座内の Raspberry Pi Zero W で動く Python エージェント |
| `cloud/` | AWS サーバーレス。顔認識、音声、イベントログ、通知 |
| `dashboard/` | 審査員がブラウザで実行できるシミュレーションモードを持つ React ウェブアプリ |

---

## アーキテクチャ

<!-- architecture diagram here (docs/architecture.md) -->

---

## Kiro の使い方

ステアリングファイル、スペック、フックについては [`docs/kiro-usage.md`](docs/kiro-usage.md) と
[`.kiro/`](.kiro/) を参照してください。

---

## 自分で作る

部品表、配線図、費用の目安は提出前にここへ追加します。以下のクラウドの手順は完成しています。
組み立てと動作確認のスクリプトは [`device/tools/README.md`](device/tools/README.md) を参照してください。
デプロイの全手順は [`docs/deployment.ja.md`](docs/deployment.ja.md) にあります。

### クラウド：デプロイ

`cloud/` のクラウドアプリは TypeScript の AWS CDK v2 です（スタック：data、judgement、api、web、budget）。
従量課金のサーバーレスサービスだけを使います。メインのリージョンは `ap-northeast-1`（東京）です。

1. AWS CLI v2 と Node.js をインストールし、自分の AWS アカウントの認証情報でサインインします。
2. 例から `cloud/cdk.context.json` を作ります。このファイルは git 管理外です。コミットしないでください。
   ```
   cd cloud
   npm install
   cp cdk.context.example.json cdk.context.json
   ```
   `cdk.context.json` の必須キー 3 つを編集します。
   | キー | 意味 |
   |---|---|
   | `notificationEmail` | 不審者通知の宛先（SNS メール購読）。 |
   | `budgetAmountUsd` | 月額予算（USD、0 より大きい値）。 |
   | `budgetEmail` | 予算アラート（50%、80%、100%）の宛先。 |
   キーが無い、または不正だと、合成（synth）はキー名つきのメッセージで失敗します。調整値
   （例：`familyMin`、`strangerMax`、`snapshotExpiryDays`、`statusIntervalS`、
   `reviewerSimulatePerHour`）は同じファイルに追加できます。`WARASHI_` で始まる環境変数
   （例：`WARASHI_FAMILY_MIN`）はコンテキストの値を上書きします。既定値と範囲は
   `cloud/lambda/_shared/config.ts` にあります。
3. アカウントを一度ブートストラップし、ビルド済みダッシュボードを含めてすべてをデプロイします。
   ```
   npx cdk bootstrap
   npx cdk deploy --all
   ```
   スタック出力には後で使う値が並びます：`IotEndpoint`、`DevicePolicyName`、
   `StrangerTopicArn`、`DataBucketName`、`HouseholdCollectionId`、`DemoCollectionId`、`ApiUrl`、
   `UserPoolId`、`UserPoolClientId`、`WebUrl`。
4. **48 時間以内にメール購読を確認してください。** 初回デプロイ後、SNS が `notificationEmail` に確認メールを
   送ります。確認するまで不審者通知は届かず、未確認の購読は 48 時間で失効します。
5. Cognito ユーザープールに family ユーザーと reviewer ユーザーを作成し（セルフサインアップは無効）、
   `family` グループと `reviewer` グループに追加します。

### クラウド：削除

```
cd cloud
npx cdk destroy --all
```

ハッカソン用のスタックは `RemovalPolicy.DESTROY` なので、データバケット、テーブル、顔コレクションも
スタックと一緒に消えます。すべてに `project=zashiki-warashi` タグが付いています。

### 人形のプロビジョニング

`scripts/provision_device.sh` は、IoT の thing と証明書を作成し、デバイスポリシーをアタッチし、
Amazon Root CA をダウンロードして、デバイス設定用の `warashi-aws.toml` を書き出します。AWS CLI v2 と
`curl` が必要です。`--out` のフォルダは git の作業ツリーの外に置く必要があり、鍵がリポジトリに入ることはありません。

```
scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
    --policy <DevicePolicyName>
```

`<DevicePolicyName>` は同名のスタック出力です。任意のフラグ：`--region`、
`--rotate`（新しい証明書を発行し、古いものを後で無効化）、`--pi-dir`（生成ファイル内のパスに使う、
Pi 上の証明書フォルダ）。フォルダを `scp` で Pi にコピーし、`warashi-aws.toml` を `config.toml` の
`[aws]` セクションに貼り付け（`device/config.example.toml` 参照）、人形の接続を確認してデプロイします。

```
python3 device/tools/check_cloud.py      # Pi 上で実行。--config、--timeout、--no-command は任意
scripts/deploy_pi.sh                     # PC から実行。$PI_HOST が必要
```

### キャッシュ音声の生成

`scripts/generate_voice_lines.py` は、自分のコンピューターで自分の AWS 認証情報を使って実行します。
Pi では実行しません。`device/warashi_agent/voice/lines.toml` を読み、Amazon Polly（ニューラル、
既定の声は Kazuha）を呼び出し、`lines.toml` の隣にセリフごとの 16 kHz モノラル WAV を書き出し、
`cloud/lambda/_shared/voice-lines.json` を更新します。変更の無いセリフはスキップされます。
PC に `boto3` が必要です。

```
python3 scripts/generate_voice_lines.py [--voice Kazuha] [--region ap-northeast-1]
```

### デモ用コレクションの投入

`POST /simulate` は、自分で用意したサンプルの顔写真に対して動きます。同意を得た顔写真を `<id>.jpg` として、
ID とラベルだけ（名前は入れない）の `manifest.json` と一緒に、リポジトリの外のローカルフォルダに置いて、
次を実行します。

```
python3 scripts/seed_demo_collection.py --bucket <DataBucketName> --samples-dir <フォルダ>
```

スクリプトはサンプルを `samples/` にアップロードし、`family` ラベルの写真だけを `warashi-demo` コレクションに
登録します。家族用コレクションには触れません。投入するまでは、`POST /simulate` は未知のサンプルを
`validation_failed` で拒否します。

### テスト

`make test` と `make lint` は、Pi も AWS アカウントも認証情報も無しで動きます。
`cloud/test/integration/` の結合テストは任意です。`WARASHI_AWS_INTEGRATION=1` を設定しない限りスキップされ、
デプロイ済みのスタックに接続します。

```
cd cloud
WARASHI_AWS_INTEGRATION=1 npx vitest --run test/integration
```

このフォルダだけを実行してください。判定のテストには、実機ではなく**テスト用**の thing が必要です
（同じ MQTT クライアント ID を使うため）。`scripts/provision_device.sh` で用意し、次の変数を設定します：
`WARASHI_IT_IOT_ENDPOINT`、`WARASHI_IT_DEVICE_ID`、`WARASHI_IT_CERT`、`WARASHI_IT_KEY`、
`WARASHI_IT_CA`、`WARASHI_IT_FAMILY_JPEG`、`WARASHI_IT_STRANGER_JPEG`。任意：
`WARASHI_IT_API_URL`、`WARASHI_IT_FAMILY_TOKEN`、`WARASHI_IT_REVIEWER_TOKEN`。各変数の説明は
`cloud/test/integration/judgement.integration.test.ts` の先頭にあります。結果（p50 と p95 のレイテンシ）は
git 管理外の `cloud/.integration-out/` に出ます。不審者のラウンドでは通知が送られることがあります。

### オーナーの作業

オーナーにしかできない作業（デモの投入、メール確認、音声の聴き取りテスト、Bedrock のモデルアクセス、
アカウント関連、結合テストの計測、実機テスト）は、
[`.kiro/specs/cloud-judgement/tasks.md`](.kiro/specs/cloud-judgement/tasks.md) の
「Owner and manual steps」にまとめてあります。

### 音声会話（任意、既定はオフ）

`family` と判定された後、人形は日本語で短い会話ができます。ダッシュボードから仮想の人形との会話を
始めることもできます。音声は AWS AppSync Events API を通って Lambda 関数（`voice-session`）に届き、
Amazon Bedrock 上の Amazon Nova Sonic と会話します。音声は P1 の機能で、基本動作がこれに依存することはなく、
すべてのセッションは人形の通常のクールダウンで終わります。

**既定はオフです。** 2 つのスイッチを両方オンにする必要があります。

| スイッチ | 場所 | 既定 |
|---|---|---|
| `voiceEnabled` | `cloud/cdk.context.json` の CDK コンテキスト。機能全体のキルスイッチ（`VoiceStack` をデプロイ） | `false` |
| `conversation_enabled` | 人形の `config.toml` | `false` |

`reviewerVoiceEnabled`（CDK コンテキスト、既定 `false`）は、さらに読み取り専用の reviewer アカウントが
ブラウザで仮想の人形と話せるようにします。

**安全とプライバシー。**
- **Nova Sonic にはガードレールがありません。** 人形はペルソナのプロンプト、モデル出力のテキストチェック
  （禁止語と言語）、1 日あたりの上限、セッションの時間制限、キルスイッチで守っています。
- **開始時の顔チェックと会話中の再チェックは、家族がそこにいることの唯一の証拠です。** 家族の写真
  （印刷物やスマホの画面）はこれを通過します。会話を認証として扱わないでください。
- 音声は人形またはブラウザから、東京リージョン（`ap-northeast-1`）の Amazon Bedrock へ送られます。
  何も保存しません。音声も文字起こしも残りません。ライブ字幕はセッション中だけ表示され、その後破棄されます。
  ペルソナのプロンプトに家族の名前は含まれません。
- ダッシュボードとステータスレポートは、マイクが動作中かどうかを表示します。

**オーナーの作業。** 全一覧（O1〜O8）は
[`.kiro/specs/voice-conversation/tasks.md`](.kiro/specs/voice-conversation/tasks.md) の
「Owner and manual steps」にあります。要点：

1. **Lambda 同時実行数のクォータ。** `voice-session` は予約同時実行数 3（`maxConcurrent`）でデプロイされます。
   Lambda はアカウント内に予約なしの 10 を必ず残します。既定の上限のままのアカウントは、`VoiceStack` を
   デプロイする前にクォータ引き上げを申請してください。そうしないとデプロイが失敗します。現在値は
   Service Quotas の Lambda「Concurrent executions」で確認できます。
2. **有効化。** `cloud/cdk.context.json` の `voiceEnabled` を `true` にし、`ap-northeast-1` の
   `amazon.nova-2-5-sonic` への Bedrock モデルアクセスを確認（O2）して、`npx cdk deploy --all` を実行します。
   スタック出力に `VoiceHttpHost` と `VoiceRealtimeHost` が加わります。
3. **日本語の品質とメッセージ順序を計測（O3）。** **Nova 2.5 Sonic は日本語を公式にはサポートしていない**ため、
   実際に聞くまで品質は未検証です。次を自分の PC で、自分の AWS 認証情報で実行します。1 つ目には `boto3` と
   Smithy の Bedrock ランタイム SDK（`aws_sdk_bedrock_runtime`）、2 つ目には `pip install websockets` とテスト用
   トークンが必要です。どちらも `/device` の依存ではありません。
   ```
   python3 scripts/check_sonic_japanese.py [--voice tiffany] [--model amazon.nova-2-5-sonic]
   python3 scripts/check_appsync_ordering.py --http-host <VoiceHttpHost> --realtime-host <VoiceRealtimeHost> --channel <テスト用チャンネル>
   ```
   1 つ目のスクリプトが書き出す WAV を聞いて、声（`tiffany` か `matthew`）を選びます。2 つ目は
   AppSync Events が音声チャンクの順序を保つかを確認します。結果は
   `.kiro/specs/voice-conversation/design.md` の「pending owner measurement」と書かれた箇所に記録します。
   日本語が十分でなければ、`voiceEnabled` はオフのままにします。
4. **キャッシュ音声。** `scripts/generate_voice_lines.py` をもう一度実行して、`conversation_trouble` と
   `conversation_bye` のセリフを人形に用意します。
5. **人形を再プロビジョニング。** AppSync のホスト名（スタック出力。両方指定するか、どちらも指定しない）を付けて、
   フォルダを Pi にコピーし、`scripts/deploy_pi.sh` を実行します。
   ```
   scripts/provision_device.sh --thing warashi-01 --out ~/warashi-secrets/warashi-01 \
       --policy <DevicePolicyName> \
       --appsync-realtime-host <VoiceRealtimeHost> --appsync-http-host <VoiceHttpHost>
   ```
6. **Pi に `websockets` をインストール（O8b）。** エージェントは pip ではなく OS のパッケージを使います。
   ```
   sudo apt install python3-websockets
   apt policy python3-websockets
   python3 -c "import websockets; print(websockets.version.version)"
   ```
7. **人形で有効化。** 上の計測と実機テスト（O8）が通ってから、`config.toml` の
   `conversation_enabled = true` にします。人形が自分の声を拾ってしまう場合は
   `conversation_mute_mic_while_speaking = true` にします。

ホスト名、トークン、証明書はコミットされません。`warashi-aws.toml` とスタック出力の中だけにあります。

### 知っておくべき制限

- **警報機ではなくアート作品です。** このガーディアンはアート作品で、警報製品ではありません。家の防犯に頼らないで
  ください。認識に生体検知が無いため、家族の写真（印刷物やスマホの画面）が家族として迎えられることがあります。
- **最も大きい顔で判定します。** 画像の中で最大の顔だけを判定するため、家族の後ろに立つ 2 人目は判定されません。

---

## プライバシーと安全

- スナップショットはオーナーの AWS アカウントにだけ保存され、7 日以内に失効します。
- 顔の登録には明示的な同意が必要で、いつでも削除できます。
- 家族の名前は、見知らぬ人に向けて話されることも表示されることもありません。
- ダッシュボードは、人形のカメラやマイクが動作中かどうかを常に表示します。
- 審査員用のデモアカウントは読み取り専用です。実際のスナップショットも、人形へのコマンドも、顔の管理もできません。
