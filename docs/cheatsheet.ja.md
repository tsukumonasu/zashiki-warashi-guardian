# コマンド早見表

人形、クラウド、ダッシュボードで日常的に使うコマンドです。`<user>@<host>.local` は、自分の
Pi のログイン情報に置き換えてください(`docs/deployment.ja.md` を参照)。秘密情報は含みません。
英語版は `docs/cheatsheet.md` です。

## Pi にデプロイする
```sh
PI_HOST=<user>@<host>.local scripts/deploy_pi.sh   # /device を rsync し、ユニットを入れて再起動
```
Pi 上の `config.toml` は、コピーも上書きもされません。スクリプトは Pi のパスワードなし `sudo`
を前提にしています。`sudo` がパスワードを求めて失敗したら、その `sudo` の手順を Pi 上で手で
実行してください。

## Pi のサービス操作
```sh
sudo systemctl restart warashi-agent     # config.toml やコードの変更を反映
sudo systemctl stop warashi-agent        # ベンチ用ツールを使う前に(下記)
sudo systemctl start warashi-agent
systemctl is-active warashi-agent
sudo systemctl disable warashi-agent     # 起動時の自動起動を止める(enable で元に戻る)
sudo shutdown -h now                     # Pi を終了。緑の LED が消えてから電源を抜く
```
サービスは Pi の起動時に自動で始まります。起動後 `pir_warmup_s`(60 秒)は、PIR を無視します。

## ログ
```sh
journalctl -u warashi-agent -f -o cat                         # 追いかける
journalctl -u warashi-agent -f -o cat | grep -v "event Pir"   # PIR の行を除く
journalctl -u warashi-agent --since "-30min" --no-pager -o cat
journalctl -u warashi-agent -o cat | grep -E "error|failed|missing"
```
通常の流れは、`sleeping -> waking -> seeking -> gazing -> greeting|warning|uncertain
-> cooldown -> sleeping` です。`sleeping` 以外の状態での PIR の反応は、無視されます。

## 設定の検証
```sh
cd ~/warashi/device
python3 -c "from warashi_agent.config import load_config; print(load_config('config.toml', fake=False))"
```
正しければ `Config(...)`、誤りがあれば、違反した規則を添えて `ConfigRejected(...)` と出ます。

## ベンチ用ツール(先にサービスを止める)
```sh
sudo systemctl stop warashi-agent
cd ~/warashi/device
python3 tools/warashi_calib.py pan | tilt       # 中心と可動範囲を決める(先に頭を手で中央に置く)
python3 tools/warashi_gaze.py demo              # agent と同じサーボ経路で動かす
python3 tools/warashi_gaze.py move              # 「<pan> <tilt>」を度で入力
python3 tools/warashi_test.py led               # ランタンのフェード
python3 tools/warashi_test.py pir               # PIR の変化
python3 tools/check_cloud.py --no-command       # クラウド接続: PASS か FAIL <step>
sudo systemctl start warashi-agent
```
`warashi_test.py servo` は tilt を ±30° まで振ります。組み立て済みの人形では実行しないでください。
ツールを使ったあとは、サービスを再起動して、姿勢の記録を実際の頭の位置に合わせます。

## Pi の音声用パッケージ(初回のみ)
```sh
sudo apt install -y python3-paho-mqtt python3-websockets
```

## クラウド(`cloud/` で実行)
```sh
npx cdk deploy --all                                   # すべて(ビルド済みダッシュボードを含む)
npx cdk deploy WebStack --exclusively                  # 1 つのスタックだけ
npx cdk diff
aws cloudformation describe-stacks --stack-name WebStack \
  --query 'Stacks[0].Outputs' --output table           # URL と ID
```
`WebStack` をデプロイする前に、ダッシュボードを再ビルドしてください(`dashboard/` で
`npm run build`)。`cdk.context.json` は git の対象外です。通知メールが本物のダッシュボードを
指すように、`dashboardUrl` に出力 `WebUrl` を設定します。

## 人形のプロビジョニング(1 台につき 1 回)
```sh
scripts/provision_device.sh --thing <deviceId> --out ~/warashi-secrets/<deviceId> \
  --policy <DevicePolicyName> --pi-dir /home/<user>/.warashi \
  --appsync-realtime-host <host> --appsync-http-host <host>
```
証明書、秘密鍵、CA ファイルは、手で Pi にコピーします。そのあと、`warashi-aws.toml` の
`[aws]` を Pi の `config.toml` に追記します。ポリシー名とホスト名は、スタックの出力です。

## テストと lint(リポジトリのルートで実行)
```sh
make test      # device、cloud、dashboard
make lint      # ruff、eslint、tsc
```

## 動作を変える設定(Pi の `config.toml`)
| キー | 効果 |
|---|---|
| `motion_enabled` | `false` の間は、サーボの動きを実行せず、ログに出すだけです。 |
| `pan_invert`, `tilt_invert` | 取り付けの向きに合わせて、サーボの向きを反転します。 |
| `pan_limit`, `tilt_limit` | 中心からの可動範囲です。ケーブルが張る手前で止めます。 |
| `glide_interval_ms` | 大きいほど遅くなります。一緒に `waking_timeout_s` と `glide_timeout_s` も上げます。 |
| `cooldown_s` | `glide_timeout_s` とランタンのフェードアウト時間の合計以上にします。 |
| `[conversation] conversation_enabled` | 家族と判定されたあとの、音声会話です。 |
| `conversation_mic_gain` | マイクのソフトウェアゲインです(0.5〜16)。 |
