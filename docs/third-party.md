# Third-party code and assets

Code or assets adapted from elsewhere, with their licenses. Frameworks and libraries used
as dependencies (listed in `pyproject.toml` / `package.json`) are summarized in the second
table below so reviewers can see what each part pulls in.

## Adapted code and assets

| What | Where in this repo | Source | License |
|---|---|---|---|
| Amazon Root CA 1 certificate (downloaded at provisioning time, not committed) | `scripts/provision_device.sh` fetches it into the owner's device folder | Amazon Trust Services repository, `https://www.amazontrust.com/repository/AmazonRootCA1.pem` | Public trust anchor published by Amazon Trust Services for connecting to AWS IoT Core; not stored in this repository |
| Minimal MQTT 3.1.1 client (CONNECT, SUBSCRIBE, PUBLISH QoS 1, PUBACK) | `cloud/test/integration/mqtt-lite.ts` | Original work for this project, written from the MQTT 3.1.1 specification. No third-party code copied. Used only by the opt-in integration test. | Project license (`LICENSE`) |

## Dependencies by part

No dependency code is copied into this repository. Versions are in the manifests.

### `/cloud` (`cloud/package.json`)

| Package | Use | License |
|---|---|---|
| `@aws-sdk/client-bedrock-runtime`, `-dynamodb`, `-iot-data-plane`, `-lambda`, `-polly`, `-rekognition`, `-s3`, `-sns`, `@aws-sdk/lib-dynamodb` | AWS service clients in the Lambda adapters | Apache-2.0 |
| `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` | Pre-signed upload and download URLs | Apache-2.0 |
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
| `pytest`, `pytest-timeout`, `hypothesis`, `ruff` (dev only, laptop) | Tests and lint | MIT, MIT, MPL-2.0, MIT |

### Scripts (laptop only)

| Package | Use | License |
|---|---|---|
| `boto3` | `scripts/generate_voice_lines.py` (Polly) and `scripts/seed_demo_collection.py` (S3, Rekognition). Imported lazily, never installed on the Pi and never a `/device` dependency. | Apache-2.0 |
