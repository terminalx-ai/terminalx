// Offline contract test; pass a package.json whose dependencies include
// @aws-sdk/client-bedrock and @aws-sdk/client-bedrock-runtime (tested: 3.1164.0).
// Also pass the reviewed installed Claude 2.1.319 artifact as argument 3.
// Rust checks this fixture against grant env AND the actual launch argv.
// Uses the extracted CLI host-filter predicate + real AWS JS requests, not a
// home-grown substitute for Claude's settings loader. Native lifecycle tests
// (startup, /cd, refresh, resume) remain a separate required execution gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { hostProviderPredicate } from "./bedrock-claude-contract.mjs";

const forbidden = () => {
  throw new Error("Network forbidden in Bedrock fixture");
};
http.request = https.request = http.get = https.get = forbidden;
net.connect = net.createConnection = tls.connect = forbidden;
globalThis.fetch = forbidden;
const require = createRequire(resolve(process.argv[2] ?? "package.json"));
const {
  BedrockClient,
  GetInferenceProfileCommand,
} = require("@aws-sdk/client-bedrock");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/src/harness/claude/fixtures/bedrock-launch.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const hostOwns = hostProviderPredicate(process.argv[3]);
const profile =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/test";

// Only exercise the real artifact predicate's provider branch. Residual SDK
// flags are pinned by --settings; this contract composition is not evidence
// that the complete native settings loader has executed.
const conflictingSettings = (generation) => ({
  AWS_BEARER_TOKEN_BEDROCK: `synthetic-stale-${generation}`,
  AWS_ACCESS_KEY_ID: "AKIAOTHER",
  AWS_SECRET_ACCESS_KEY: "synthetic-other-secret",
  AWS_SESSION_TOKEN: "synthetic-mismatched-session",
  AWS_PROFILE: "synthetic-profile",
  AWS_CONFIG_FILE: "/synthetic/other-config",
  AWS_SHARED_CREDENTIALS_FILE: "/synthetic/other-credentials",
  AWS_ROLE_ARN: "synthetic-role",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/synthetic/web-identity",
  AWS_CONTAINER_CREDENTIALS_FULL_URI:
    "https://synthetic-endpoint.invalid/container",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/synthetic/container",
  AWS_CONTAINER_AUTHORIZATION_TOKEN: "synthetic-container-token",
  AWS_EC2_METADATA_SERVICE_ENDPOINT:
    "https://synthetic-endpoint.invalid/metadata",
  AWS_REGION: "eu-west-1",
  AWS_DEFAULT_REGION: "eu-west-1",
  AWS_ENDPOINT_URL_BEDROCK: "https://synthetic-endpoint.invalid/control",
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
    "https://synthetic-endpoint.invalid/runtime",
  AWS_ENDPOINT_URL_STS: "https://synthetic-endpoint.invalid/sts",
  AWS_ENDPOINT_URL: "https://synthetic-endpoint.invalid/global",
  ANTHROPIC_BEDROCK_BASE_URL: "https://synthetic-endpoint.invalid/invoke",
  CLAUDE_CODE_USE_BEDROCK: "0",
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
});
function launchedEnv(scheme, generation) {
  const selected = Object.fromEntries(
    Object.entries(scheme.env).filter(([, value]) => value !== null),
  );
  const fixed = { ...contract.publicEnv, ...selected };
  const effective = { ...fixed };
  assert.deepEqual(contract.settingsSources, [
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
  ]);
  for (const source of contract.settingsSources) {
    for (const [key, value] of Object.entries(
      conflictingSettings(`${source}-${generation}`),
    )) {
      assert.equal(
        hostOwns(key),
        true,
        `CLI does not filter ${key} from ${source}`,
      );
      if (!hostOwns(key)) effective[key] = value;
    }
  }
  for (const key of contract.clearedEnv)
    assert.equal(effective[key], undefined);
  for (const [key, value] of Object.entries(scheme.env))
    assert.equal(effective[key], value ?? undefined);
  return effective;
}

async function requests(env, expectedHosts) {
  const previous = process.env;
  process.env = { ...env };
  const captured = [];
  const requestHandler = {
    async handle(request) {
      captured.push(request);
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from("{}"),
        },
      };
    },
  };
  const clients = [];
  try {
    const discovery = new BedrockClient({
      region: env.AWS_REGION,
      requestHandler,
      maxAttempts: 1,
    });
    const runtime = new BedrockRuntimeClient({
      region: env.AWS_REGION,
      requestHandler,
      maxAttempts: 1,
      endpoint: env.ANTHROPIC_BEDROCK_BASE_URL,
    });
    clients.push(discovery, runtime);
    await discovery.send(
      new GetInferenceProfileCommand({ inferenceProfileIdentifier: profile }),
    );
    await runtime.send(
      new InvokeModelCommand({
        modelId: profile,
        body: Buffer.from("{}"),
        contentType: "application/json",
      }),
    );
    assert.deepEqual(
      captured.map((request) => request.hostname),
      expectedHosts,
    );
    for (const request of captured) {
      assert.equal(request.protocol, "https:");
      assert.ok(request.path.includes("application-inference-profile"));
      if (env.AWS_BEARER_TOKEN_BEDROCK) {
        assert.equal(
          request.headers.Authorization ?? request.headers.authorization,
          "Bearer synthetic-bedrock-key",
        );
        assert.equal(request.headers["x-amz-security-token"], undefined);
      } else {
        assert.ok(
          request.headers.authorization.includes(
            `Credential=${env.AWS_ACCESS_KEY_ID}/`,
          ),
        );
        assert.equal(
          request.headers["x-amz-security-token"] ?? "",
          env.AWS_SESSION_TOKEN ?? "",
        );
      }
    }
  } finally {
    clients.forEach((client) => client.destroy());
    process.env = previous;
  }
}

for (const scheme of contract.schemes) {
  test(`${scheme.name}: host predicate excludes conflicting settings from AWS requests`, async () => {
    for (const generation of [
      "initial",
      "refreshed",
      "changed-project",
      "resumed",
    ]) {
      await requests(launchedEnv(scheme, generation), [
        "bedrock.us-east-1.amazonaws.com",
        "bedrock-runtime.us-east-1.amazonaws.com",
      ]);
    }
  });
}
test("AWS ignores inherited/service endpoint overrides, including profile discovery", async () => {
  const env = launchedEnv(contract.schemes[2], "initial");
  for (const name of [
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_ENDPOINT_URL_STS",
  ]) {
    env[name] = "https://synthetic-endpoint.invalid";
  }
  await requests(env, [
    "bedrock.us-east-1.amazonaws.com",
    "bedrock-runtime.us-east-1.amazonaws.com",
  ]);
});
test("negative control detects a discovery redirect if the ignore policy is removed", async () => {
  const env = launchedEnv(contract.schemes[2], "initial");
  env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "false";
  env.AWS_ENDPOINT_URL_BEDROCK = "https://synthetic-endpoint.invalid";
  // Still intercepted entirely in memory. No socket can be opened.
  await requests(env, [
    "synthetic-endpoint.invalid",
    "bedrock-runtime.us-east-1.amazonaws.com",
  ]);
});

test("empty bearer is not a deletion sentinel: it must never reach a key route", async () => {
  const env = launchedEnv(contract.schemes[1], "initial");
  env.AWS_BEARER_TOKEN_BEDROCK = "";
  // A real SDK regression: even sigv4 preference does not undo the bearer
  // selector's presence check. No request is sent by this failing client.
  await assert.rejects(requests(env, []), /token/);
});
