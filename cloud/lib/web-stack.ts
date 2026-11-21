/**
 * WebStack: private S3 site bucket, CloudFront with origin access control, SPA fallback and the
 * runtime `/config.json` (R18.1 to R18.9).
 *
 * Dependency direction is one way: WebStack reads values of ApiStack, never the other way round.
 * The CORS origin that ApiStack cannot know (the CloudFront domain exists only after this stack)
 * is applied from here by a custom resource that calls `UpdateApi` on the HTTP API. See "Web and
 * API stack cycle" in `design.md`.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  custom_resources as cr,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

/** Longest CloudFront cache lifetime for `/config.json` in seconds (R18.8). */
export const CONFIG_JSON_MAX_AGE_SECONDS = 60;
/** The only keys of `/config.json` (R18.6). */
export const CONFIG_JSON_KEYS = ["apiUrl", "region", "userPoolId", "userPoolClientId", "illustrationBase"] as const;
/** Dashboard origin-relative folder of the reviewer illustrations (see `schema.md`, "Base URL and settings"). */
export const ILLUSTRATION_BASE = "/illustrations/";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Default location of the built dashboard: `<repo>/dashboard/dist`. */
export const DEFAULT_DASHBOARD_DIST = resolve(HERE, "..", "..", "dashboard", "dist");

/** One-page placeholder deployed when the dashboard has not been built (R18.5). */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zashiki-Warashi Guardian</title></head>
<body><main><h1>Zashiki-Warashi Guardian</h1>
<p>The dashboard has not been built yet. Run the dashboard build and deploy again.</p></main></body></html>
`;

export interface WebStackProps extends StackProps {
  /** HTTP API URL from ApiStack (R18.6). */
  apiUrl: string;
  /** HTTP API id from ApiStack; used to set the CORS origin from this stack. */
  apiId: string;
  userPoolId: string;
  userPoolClientId: string;
  /** AppSync Events API hosts from VoiceStack; added to the CSP `connect-src` (voice R16.6). */
  voiceHttpHost: string;
  voiceRealtimeHost: string;
  /** Name of the DataStack bucket; this stack sets its CORS rule (browser face uploads). */
  dataBucketName: string;
  /** Folder with the built dashboard. Defaults to `<repo>/dashboard/dist`. */
  dashboardDistPath?: string;
  /** CORS settings applied to the HTTP API together with the CloudFront origin. */
  cors?: { allowMethods?: string[]; allowHeaders?: string[]; maxAgeSeconds?: number };
}

/** True when the dashboard build folder exists and holds at least one entry. */
export function dashboardBuilt(distPath: string): boolean {
  return existsSync(distPath) && readdirSync(distPath).length > 0;
}

export class WebStack extends Stack {
  readonly siteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly webUrl: string;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          // Snapshots and speech are pre-signed S3 URLs; sign-in calls Cognito directly.
          contentSecurityPolicy: [
            "default-src 'self'",
            `connect-src 'self' ${props.apiUrl} https://cognito-idp.${this.region}.amazonaws.com https://${props.voiceHttpHost} wss://${props.voiceRealtimeHost}`,
            "img-src 'self' data: https://*.amazonaws.com",
            "media-src 'self' https://*.amazonaws.com",
            "style-src 'self' 'unsafe-inline'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join("; "),
          override: true,
        },
      },
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket);

    // `/config.json` is cached for at most 60 s even if an object header says more (R18.8).
    const configCachePolicy = new cloudfront.CachePolicy(this, "ConfigCachePolicy", {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(CONFIG_JSON_MAX_AGE_SECONDS),
      maxTtl: Duration.seconds(CONFIG_JSON_MAX_AGE_SECONDS),
    });

    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: "/index.html",
      ttl: Duration.seconds(0),
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      comment: "Zashiki-Warashi Guardian dashboard",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: {
        "/config.json": {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: configCachePolicy,
          responseHeadersPolicy: headers,
          compress: true,
        },
      },
      // A missing key gives 403 (no s3:ListBucket for OAC) or 404; both serve the SPA shell (R18.3).
      errorResponses: [spaFallback(403), spaFallback(404)],
    });

    this.webUrl = `https://${this.distribution.distributionDomainName}`;

    // Dashboard bundle or placeholder (R18.4, R18.5). `config.json` belongs to the second deployment.
    const distPath = props.dashboardDistPath ?? DEFAULT_DASHBOARD_DIST;
    const assets = dashboardBuilt(distPath)
      ? s3deploy.Source.asset(distPath)
      : s3deploy.Source.data("index.html", PLACEHOLDER_HTML);
    new s3deploy.BucketDeployment(this, "DeployAssets", {
      sources: [assets],
      destinationBucket: this.siteBucket,
      exclude: ["config.json"],
      prune: true,
      distribution: this.distribution,
      distributionPaths: ["/*"],
    });

    // Runtime settings. The values are resolved at deploy time, so a changed backend needs
    // no dashboard rebuild (R18.7). No secret and no credential is ever added here (R18.9).
    const config: Record<(typeof CONFIG_JSON_KEYS)[number], string> = {
      apiUrl: props.apiUrl,
      region: this.region,
      userPoolId: props.userPoolId,
      userPoolClientId: props.userPoolClientId,
      illustrationBase: ILLUSTRATION_BASE,
    };
    const deployConfig = new s3deploy.BucketDeployment(this, "DeployConfig", {
      sources: [s3deploy.Source.jsonData("config.json", config)],
      destinationBucket: this.siteBucket,
      prune: false,
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.seconds(CONFIG_JSON_MAX_AGE_SECONDS)),
      ],
      distribution: this.distribution,
      distributionPaths: ["/config.json"],
    });
    // Order the two uploads so the config always lands after a pruning run of the assets.
    deployConfig.node.addDependency(this.node.findChild("DeployAssets"));

    // CORS origin of the HTTP API: the CloudFront domain is known only here (see file comment).
    const cors = props.cors ?? {};
    new cr.AwsCustomResource(this, "ApiCorsOrigin", {
      onUpdate: {
        service: "ApiGatewayV2",
        action: "updateApi",
        parameters: {
          ApiId: props.apiId,
          CorsConfiguration: {
            AllowOrigins: [this.webUrl],
            AllowMethods: cors.allowMethods ?? ["GET", "POST", "DELETE", "OPTIONS"],
            AllowHeaders: cors.allowHeaders ?? ["authorization", "content-type"],
            MaxAge: cors.maxAgeSeconds ?? 600,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.apiId}-cors`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["apigateway:PATCH"],
          resources: [`arn:${this.partition}:apigateway:${this.region}::/apis/${props.apiId}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // CORS rule of the data bucket for browser uploads of face photos (dashboard-simulation X2,
    // R15.5). Same cycle resolution as the API: the CloudFront origin is known only here, so this
    // stack sets the rule on the bucket of DataStack. The origin is never `*`.
    new cr.AwsCustomResource(this, "DataBucketCorsOrigin", {
      onUpdate: {
        service: "S3",
        action: "putBucketCors",
        parameters: {
          Bucket: props.dataBucketName,
          CORSConfiguration: {
            CORSRules: [
              { AllowedOrigins: [this.webUrl], AllowedMethods: ["POST"], AllowedHeaders: ["*"], MaxAgeSeconds: 600 },
            ],
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${props.dataBucketName}-cors`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["s3:PutBucketCORS"],
          resources: [`arn:${this.partition}:s3:::${props.dataBucketName}`],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    new CfnOutput(this, "WebUrl", { value: this.webUrl, description: "Dashboard URL" });
  }
}
