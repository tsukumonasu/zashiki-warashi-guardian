# Third-party code and assets

Code or assets adapted from elsewhere, with their licenses. Frameworks and libraries used
as dependencies (listed in `pyproject.toml` / `package.json`) are summarized in the second
table below so reviewers can see what each part pulls in.

## Adapted code and assets

| What | Where in this repo | Source | License |
|---|---|---|---|
| Amazon Root CA 1 certificate (downloaded at provisioning time, not committed) | `scripts/provision_device.sh` fetches it into the owner's device folder | Amazon Trust Services repository, `https://www.amazontrust.com/repository/AmazonRootCA1.pem` | Public trust anchor published by Amazon Trust Services for connecting to AWS IoT Core; not stored in this repository |
| Minimal MQTT 3.1.1 client (CONNECT, SUBSCRIBE, PUBLISH QoS 1, PUBACK) | `cloud/test/integration/mqtt-lite.ts` | Original work for this project, written from the MQTT 3.1.1 specification. No third-party code copied. Used only by the opt-in integration test. | Project license (`LICENSE`) |
| Shippori Mincho Regular and SemiBold, subset to ASCII plus the Japanese characters of the voice catalog and the landing title (`pyftsubset`, woff2) | `dashboard/public/fonts/ShipporiMincho-Regular.subset.woff2`, `ShipporiMincho-SemiBold.subset.woff2`; license text in `dashboard/public/fonts/OFL.txt` | Shippori Mincho Project Authors, `https://github.com/google/fonts/tree/main/ofl/shipporimincho` (copyright 2021, `https://github.com/fontdasu/ShipporiMincho`) | SIL Open Font License 1.1. The copyright line declares no Reserved Font Name. Characters outside the subset fall back to the system serif. |
| Dashboard illustrations `silhouette-{family,stranger,none,uncertain}.svg` | `dashboard/public/illustrations/` | Original work for this project, drawn from basic SVG shapes. No third-party artwork. | Project license (`LICENSE`) |
| GenU (Generative AI Use Cases JP), read for ideas about browser audio capture and a Nova Sonic session. **No source file is copied or adapted**; the voice session code is original work. | None | `https://github.com/aws-samples/generative-ai-use-cases` at commit `eaac751202f8971c38b6870840709ba8802ee333` (read 2026-11-21) | MIT-0, [LICENSE](https://github.com/aws-samples/generative-ai-use-cases/blob/main/LICENSE) |
| Amazon Nova samples, read for ideas about the Nova Sonic event sequence. **No source file is copied or adapted.** The repository appears to have been renamed `amazon-ai-samples`. | None | `https://github.com/aws-samples/amazon-nova-samples` at commit `86b78ef2f0fd8919347b9564cca9dff730bc8c43` (read 2026-11-21) | MIT-0, [LICENSE](https://github.com/aws-samples/amazon-nova-samples/blob/main/LICENSE) |
| Dashboard audio (`dashboard/public/audio/`) | Not present yet. When the files from `scripts/generate_voice_lines.py` (Amazon Polly output) are added, list them here. | Generated with Amazon Polly in the owner's AWS account | Polly output usable under the AWS service terms; no third-party recordings |

## Dependencies by part

No dependency code is copied into this repository. Versions are in the manifests.

### `/cloud` (`cloud/package.json`)

| Package | Use | License |
|---|---|---|
| `@aws-sdk/client-bedrock-runtime`, `-dynamodb`, `-iot-data-plane`, `-lambda`, `-polly`, `-rekognition`, `-s3`, `-sns`, `@aws-sdk/lib-dynamodb` | AWS service clients in the Lambda adapters | Apache-2.0 |
| `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` | Pre-signed upload and download URLs | Apache-2.0 |
| `@smithy/signature-v4`, `@smithy/protocol-http`, `@smithy/types`, `@aws-crypto/sha256-js` | SigV4 signing of the AppSync Events WebSocket and publish requests of the voice session | Apache-2.0 |
| `@smithy/node-http-handler` | HTTP/2 handler for the Bedrock bidirectional stream | Apache-2.0 |
| `@aws-sdk/credential-provider-node` | Supplies the Lambda role credentials to the signer | Apache-2.0 |
| `aws-cdk-lib`, `constructs` | Infrastructure definition | Apache-2.0 |
| `aws-cdk` (dev) | `cdk synth` and `cdk deploy` | Apache-2.0 |
| `tsx` (dev) | Runs the TypeScript CDK app without a build step | MIT |
| `esbuild` (dev) | Bundles the Lambda functions | MIT |
| `typescript`, `typescript-eslint`, `eslint`, `@eslint/js`, `@types/node` (dev) | Type checking and lint | Apache-2.0 (TypeScript), MIT (others) |
| `vitest`, `fast-check`, `aws-sdk-client-mock` (dev) | Unit and property tests | MIT |

### `/device`

| Package | Use | License |
|---|---|---|
| `python3-paho-mqtt` (apt, Raspberry Pi OS) | MQTT client used by `MqttCloudLink` on the Pi | EPL-2.0 / EDL-1.0 (dual) |
| `python3-gpiozero`, `python3-lgpio` (apt) | GPIO, servos, PIR, lantern | BSD-3-Clause (gpiozero), Unlicense (lgpio) |
| `python3-websockets` (apt, Raspberry Pi OS; installed from the OS package, not vendored) | WebSocket client of the voice session | BSD-3-Clause |
| `pytest`, `pytest-timeout`, `hypothesis`, `ruff` (dev only, laptop) | Tests and lint | MIT, MIT, MPL-2.0, MIT |
| `websockets` (dev only, laptop) | Loopback server of the voice-conversation tests | BSD-3-Clause |

### Scripts (laptop only)

| Package | Use | License |
|---|---|---|
| `aws_sdk_bedrock_runtime` (experimental AWS SDK for Python) | `scripts/check_sonic_japanese.py` only: carries the HTTP/2 bidirectional stream that `boto3` cannot. Imported lazily, never installed on the Pi. | Apache-2.0 |
| `websockets` | `scripts/check_appsync_ordering.py` only. Imported lazily, never a `/device` dependency. | BSD-3-Clause |
| `boto3` | `scripts/generate_voice_lines.py` (Polly) and `scripts/seed_demo_collection.py` (S3, Rekognition). Imported lazily, never installed on the Pi and never a `/device` dependency. | Apache-2.0 |
