// A local TerminalX relay (Director + Cell on Redis) for the cloud workspace
// integration test (PRO-13). It runs the terminalx-saas relay code itself, so
// the runtime and the desktop client are tested against the deployed wire
// format, and signs the credentials the API would issue:
//   - runtime Relay Tokens (`sub: cloud-runtime:<workspace>`, `runtimeGeneration`)
//   - attach tickets (`typ: terminalx-attach+jwt`, 60 s)
//
// Run from terminalx-saas `apps/relay` so its `@/` imports resolve:
//   cd $TERMINALX_SAAS_DIR/apps/relay && \
//     RELAY_TEST_REDIS_URL=redis://127.0.0.1:56379 bun <terminalx>/scripts/remote-runtime/relay-harness.ts
//
// Prints one JSON line `{ "type": "ready", controlUrl, directorUrl, cellUrl }`.
// The control endpoint (loopback only) signs credentials and restarts the Cell:
//   POST /runtime-token { relayHostId, runtimeGeneration } -> { relayToken }
//   POST /ticket        { relayHostId, runtimeGeneration, deviceId?, attachmentId? } -> { token, expiresAt }
//   POST /restart-cell  -> {}   (drops every relay socket, as a Cell restart does)
// It exits when stdin closes.
import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'

const saas = process.env.TERMINALX_SAAS_DIR ?? `${process.cwd()}/../..`
const { signRelayToken } = await import(`${saas}/apps/api/src/lib/relayToken`)
const { signWorkspaceAttachTicket } = await import(
    `${saas}/apps/api/src/lib/workspaceAttachTicket`
)
const { relayKeyFromPem } = await import(
    `${saas}/apps/relay/src/protocol/relay-token`
)
const { connectRelayRedis } = await import(
    `${saas}/apps/relay/src/registry/redis-store`
)
const { PlacementRegistry } = await import(
    `${saas}/apps/relay/src/registry/placement-registry`
)
const { DeviceCredentialStore } = await import(
    `${saas}/apps/relay/src/registry/device-credential-store`
)
const { HostPresenceRegistry } = await import(
    `${saas}/apps/relay/src/registry/host-presence-registry`
)
const { RuntimeGenerationFence } = await import(
    `${saas}/apps/relay/src/registry/runtime-generation-fence`
)
const { DirectorServer } = await import(
    `${saas}/apps/relay/src/director/director-server`
)
const { CellServer } = await import(`${saas}/apps/relay/src/cell/cell-server`)

const REDIS_URL = process.env.RELAY_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379'
const WORKSPACE = 'workspace-e2e'
const ORGANIZATION = 'org-e2e'
const USER = 'user-e2e'

const freePort = (): number => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)
    return port
}

const keys = generateKeyPairSync('ed25519')
const privateKey = createPrivateKey(
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
)
const relayTokenPublicKey = relayKeyFromPem(
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
)
const redis = connectRelayRedis(REDIS_URL, `relay-e2e-${randomUUID()}`)
const placement = new PlacementRegistry(redis, 600_000)
const credentials = new DeviceCredentialStore(redis)
const presence = new HostPresenceRegistry(redis)
const fence = new RuntimeGenerationFence(redis)

const director = new DirectorServer(
    {
        role: 'director',
        port: freePort(),
        redisUrl: REDIS_URL,
        relayTokenPublicKey,
        leaseTtlMs: 600_000
    },
    placement,
    credentials,
    Date.now,
    presence
).listen()
const cellPort = freePort()
const cellUrl = `http://127.0.0.1:${cellPort}`
const cellConfig = {
    role: 'cell' as const,
    port: cellPort,
    redisUrl: REDIS_URL,
    relayTokenPublicKey,
    leaseTtlMs: 600_000,
    cellId: `e2e-cell-${randomUUID()}`,
    cellUrl,
    maxBufferedBytesPerConnection: 4 * 1024 * 1024,
    maxBufferedMs: 5_000,
    maxHostsPerCell: 10,
    drainGraceMs: 0
}
const startCell = () =>
    new CellServer(
        cellConfig,
        placement,
        credentials,
        Date.now,
        presence,
        fence
    ).listen()
let cell = startCell()

const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const control = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
        const url = new URL(request.url)
        const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
        >
        if (url.pathname === '/runtime-token') {
            const { relayToken, expiresAt } = signRelayToken(
                {
                    sub: `cloud-runtime:${WORKSPACE}`,
                    cloudProfileId: `cloud-workspace:${WORKSPACE}`,
                    organizationId: ORGANIZATION,
                    relayHostId: String(body.relayHostId),
                    hostUserId: USER,
                    runtimeGeneration: Number(body.runtimeGeneration)
                },
                privateKey
            )
            return json({ relayToken, expiresAt })
        }
        if (url.pathname === '/ticket') {
            const ticket = signWorkspaceAttachTicket(
                {
                    userId: USER,
                    clientInstallationId: String(body.deviceId ?? 'desktop-e2e'),
                    attachmentId: String(body.attachmentId ?? 'attachment-e2e'),
                    workspaceId: WORKSPACE,
                    organizationId: ORGANIZATION,
                    relayHostId: String(body.relayHostId),
                    runtimeGeneration: Number(body.runtimeGeneration)
                },
                privateKey,
                Date.now()
            )
            return json({ token: ticket.token, expiresAt: ticket.expiresAt })
        }
        if (url.pathname === '/restart-cell') {
            cell.stop(true)
            await Bun.sleep(200)
            cell = startCell()
            await Bun.sleep(100)
            return json({})
        }
        return json({ error: 'not_found' }, 404)
    }
})

await Bun.sleep(50)
console.log(
    JSON.stringify({
        type: 'ready',
        controlUrl: `http://127.0.0.1:${control.port}`,
        directorUrl: `http://127.0.0.1:${director.port}`,
        cellUrl
    })
)

const shutdown = () => {
    cell.stop(true)
    director.stop(true)
    control.stop(true)
    redis.close()
    process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.resume()
