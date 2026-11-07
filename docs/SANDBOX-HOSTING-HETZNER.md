# Self-hosting agent sandboxes on Hetzner dedicated servers vs managed sandbox providers

Research note, 2026-10-30. All prices and facts were retrieved on 2026-10-30
unless a row says otherwise. Prices exclude VAT unless stated.

**How to read this note:**

- **Facts** carry a link to the source that owns them: the vendor's pricing
  page, docs, price API or source repository.
- **Assumptions** are tagged `[A]` and listed in §7.1. Each one is a named
  parameter in `PARAMS` of the calculator (Appendix A), so a reader can change
  it and rerun.
- **All arithmetic** comes from that script (`python3 sandbox_cost_calc.py`).
  The tables marked "calculator output" are pasted from its run on 2026-10-30.

---

## 1. Executive summary

**Recommendation: do not build a self-hosted sandbox platform now. Keep Boat
as the default provider.** Self-hosting on Hetzner dedicated servers does not
beat Boat on cost for TerminalX's workload. It only makes sense if TerminalX
needs something Boat cannot sell:

- memory-preserving suspend at Boat's price;
- its own data boundary;
- more than Boat's 2,000-concurrency self-serve limit;
- a fleet that stays more than about 80% busy.

### Why

1. **Boat already charges about what bare metal costs a Hetzner customer at
   full utilisation.**
   - Boat `small` (2 vCPU / 4 GB / 51 GB) is **$0.018/h**, and `default`
     (4 vCPU / 8 GB / 51 GB) is **$0.036/h**, billed per second, with nothing
     billed while stopped ([docs.boat.dev/pricing.md](https://docs.boat.dev/pricing.md)).
   - A Hetzner AX102-1 ($304.00/month with IPv4) holds 28 such sandboxes at 1x
     RAM. That is $10.86 per slot-month, or **$0.0149 per slot-hour at 100%
     utilisation**, hardware only.
   - Under TerminalX's pattern (8 active hours per weekday = 173.3 h/month =
     23.7% utilisation `[A]`) the same slot costs **$0.0626/h**, about 3.5x
     Boat.
   - Hardware alone matches Boat only at **≥83% fleet utilisation** (T7).
2. **InstaBox is the only other provider at Boat's price.** Its rates are
   $0.017/h for Profile A and $0.0362/h for Profile B. Unlike Boat, it pauses
   with memory, using Firecracker
   ([instabox.sh/docs/pricing.md](https://instabox.sh/docs/pricing.md),
   [limits.md](https://instabox.sh/docs/limits.md)). It is very new, and its
   largest self-serve plan stops at 500 running machines.
3. **E2B, Daytona and Boxd cost 8–9x Boat per hour.** Against them,
   self-hosting pays for its hardware at very small scale: 3–24 peak
   sandboxes. Counting a lean 0.5 FTE of engineering `[A]` moves the
   break-even to 36–497 peak sandboxes, depending on profile and usage (§7.6).
4. **The open-source landscape shifted in 2026:**
   - Cua Cloud ended on 2026-10-18, so there is no managed Cua to compare.
   - Daytona's open-source repo is archived ("core development has moved to
     a private codebase"). Its last release is v0.190.0 (2026-06-23) and its
     last push 2026-07-24, so the archive came on or after that date.
   - E2B's multi-node Nomad/Terraform self-host stack was deleted on
     2026-09-10. Its supported self-host is now **single-node "Embed"**, capped
     at 200 running sandboxes per node (§4).
5. **If TerminalX self-hosts anyway, the lowest-build path is E2B Runtime
   Embed**, one node per server from point 6.
   - TerminalX would write the placement, wildcard TLS ingress, auth and
     metering layer itself.
   - A more conservative design is Coder plus Incus VMs, which needs more
     integration work.
   - Either way, TerminalX becomes the compute provider. Today customers bring
     their own Boat or Hetzner key (`src/lib/organizationCompute.ts`).
6. **Cheapest Hetzner server per sandbox (re-checked 2026-11-01, §2.7):**
   - **New AX/EX servers take no RAM or drive add-ons.** More RAM or disk
     means buying a bigger fixed variant. Only Server Auction boxes take
     add-ons.
   - **Cheapest per sandbox: an auction AX161** (EPYC 7502P, 64 threads),
     upgraded to 480–512 GB of DDR4 at $22 per 32 GB. That is **$6.86–8.62 per
     Boat `small` a month**, at 4x CPU and 116 per box.
   - **Best new server: AX102-1** at **$11.30 per `small`**, 28 per box.
   - Big new servers (AX162-x, EX131-x, AX102-2/-3/-4) cost $15–67 per
     sandbox.
   - The LTD tier is priced by Hetzner's API but is not in the shop today.

### Headline: cost per sandbox-hour (USD)

| Option | Profile A (2 vCPU / 4 GiB / 20 GiB) | Profile B (4 vCPU / 8 GiB / 40 GiB) | Billed while suspended |
|---|---|---|---|
| **Boat** (`small` / `default`) | **$0.0180** | **$0.0360** | $0 (disk kept 14 days) |
| InstaBox | $0.0170 | $0.0362 | disk beyond 20 GiB only ($0.00011/GiB-h) |
| Boxd (USD card; RAM resident = profile RAM) | $0.1519 | $0.3038 | written disk ($0.000096/GiB-h) |
| E2B (Pro; + $150/month plan fee) | $0.1656 | $0.3312 (40 GiB disk needs support) | $0 (pause keeps memory) |
| Daytona | $0.1672 | $0.3350 | reserved disk after 5 GiB free |
| Cua | n/a: Cua Cloud ended 2026-10-18 | n/a | n/a |
| Hetzner AX102-1, hardware only, at 100% / 50% / 23.7% utilisation | $0.0149 / $0.0297 / $0.0626 | $0.0297 / $0.0595 / $0.1253 | (fixed cost) |
| Hetzner AX102-1 fleet, N=200, N+1 + Storage Box + setup/12, always-on / U1 | $0.0198 / $0.0835 | $0.0353 / $0.1487 | (fixed cost) |
| Same fleet + 0.5 FTE ops `[A]`, always-on / U1 | $0.0712 / $0.2998 | $0.0867 / $0.3650 | (fixed cost) |

### Headline: break-even peak concurrency

Self-hosting on AX102-1 at 2x CPU, with N+1, against Profile A. The full table
is T6 in §7.6.

| vs | U1, hardware only | U1, +0.5 FTE | U1, +1.0 FTE | always-on, hardware only | always-on, +0.5 FTE | always-on, +1.0 FTE |
|---|---|---|---|---|---|---|
| **Boat** | none up to 2,000 | none up to 2,000 | none up to 2,000 | **245** | none up to 2,000 | none up to 2,000 |
| InstaBox | none up to 500 | none up to 500 | none up to 500 | 388 | none up to 500 | none up to 500 |
| Boxd | 24 | 497 | 970 | 6 | 80 | 156 |
| E2B | 18 | 430 | 830 | 5 | 72 | 135 |
| Daytona | 22 | 434 | 836 | 6 | 72 | 142 |

"none up to N" means self-hosting is never cheaper before the provider's
published self-serve limit, which is 2,000 concurrent for Boat and 500 running
for InstaBox. Beyond that limit, pricing is custom and not published.

### Headline: what $1,500 and $2,000 a month buy in Boat sizes

Concurrent sandboxes; USD list prices; 2x CPU overcommit; RAM 1x; thick disk.
Details are in §2.

| Budget | Hetzner fleet | Boat `small` (2/4/51) | `default` (4/8/51) | `large` (8/16/111) | `xlarge` (16/32/251) |
|---|---|---|---|---|---|
| $1,500 | 4x AX102-1, with N+1 (without) | **80** (108) | **40** (54) | **20** (27) | **9** (12) |
| $1,500 | same money on Boat, always-on / U1 seats | 114 / 480 | 57 / 240 | 28 / 120 | 10 / 43 |
| $2,000 | 6x AX102-1, with N+1 (without) | **136** (164) | **68** (82) | **34** (41) | **15** (18) |
| $2,000 | same money on Boat, always-on / U1 seats | 152 / 641 | 76 / 320 | 38 / 160 | 13 / 57 |

---

## 2. Capacity at a $1,500–$2,000/month budget

### 2.1 Boat's sandbox catalogue (the sizes this section measures in)

Boat is the provider TerminalX shows as "Boat" (provider id `box`,
`src-tauri/src/cloud_workspaces.rs:58`). Sources:
[docs.boat.dev/pricing.md](https://docs.boat.dev/pricing.md),
[machines.md](https://docs.boat.dev/machines.md),
[limits.md](https://docs.boat.dev/limits.md),
[snapshots.md](https://docs.boat.dev/snapshots.md),
[machines/virtualization.md](https://docs.boat.dev/machines/virtualization.md),
[faq.md](https://docs.boat.dev/faq.md) and
[security.md](https://docs.boat.dev/security.md).

| Size | vCPU | RAM | Disk (own files; OS not included) | $/hour | $ per 730 h |
|---|---|---|---|---|---|
| `small` | 2 | 4 GB | 51 GB | 0.018 | 13.14 |
| `default` | 4 | 8 GB | 51 GB | 0.036 | 26.28 |
| `large` | 8 | 16 GB | 111 GB | 0.072 | 52.56 |
| `xlarge` (needs the $100 plan or higher) | 16 | 32 GB | 251 GB | 0.200 | 146.00 |

**Sizes and billing**

- "These four sizes are the only sizes."
- Billing is per second while running. "A stopped sandbox costs no machine time."

**Plans** ($20, $100, $500 and $2,000 a month) are prepaid compute, not a fee:
"Every dollar comes back as VM time at the rates above."

| Plan | Run at once |
|---|---|
| $20 | 100 |
| $100 | 300 |
| $500 | 1,000 |
| $2,000 | 2,000 |

- Overage comes from a wallet at the same rates.
- An organization "pays the plan price once per seat".

**Stop and snapshots**

- "There is no pause." A stop keeps the disk for 14 days.
- "Memory and running programs are not in a snapshot. A stop is not a hibernate."
- Saved snapshots: 10 are included, then $0.056 a day each.
- Auto-stop: "Default 1 hour. Maximum 30 days, or off."

**Hosts and isolation**

- Each sandbox is "its own virtual machine, with its own kernel, disk and IP address".
- "Sandboxes have shared vCPUs."
- "Every sandbox runs on a dedicated AMD Ryzen 9 9950X (Zen 5) host", and
  nested `/dev/kvm` is available. The hypervisor is not named.

**Region and tax**

- "Sandboxes run in the EU: Germany, Finland and France. You cannot pick a region."
- Checkout adds no VAT
  ([billing/plan-changes.md](https://docs.boat.dev/billing/plan-changes.md)).

**Boat's published utilisation** (pricing.md, last 30 days, per sandbox) is a
useful prior for overcommit:

| Population | CPU busy | RAM used |
|---|---|---|
| Median | 8.79% | 18.89% |
| Average | 11.11% | 22.97% |
| Busiest 1% | 92.06% | 36.1% |

**Repo lead not confirmed.** A fixture in
`src/components/cloud/CloudCreateWorkspace.test.tsx:180` reads "Boat · Standard
(4 vCPU, 8 GB) · Frankfurt" at "$0.12 an hour". boat.dev publishes no
"Standard" size, no Frankfurt choice and no $0.12 rate. Its 4 vCPU / 8 GB size
is `default` at $0.036/h. The fixture is test data and is not used here (see §9).

### 2.2 Currency, VAT and setup fees

- **Hetzner publishes both EUR and USD prices.** For example AX102-1 is
  €257.30 or $302.10 a month excluding IPv4; Primary IPv4 is €1.70 or $1.90
  ([price adjustment table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/),
  [IP pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/)).
- **Two ways to convert to USD:**
  - **USD list**: Hetzner's own USD price, for a USD-billed account. This is
    the headline method.
  - **EUR@ECB**: the EUR price × **1.1172 USD/EUR**, the ECB reference rate
    for 2026-10-30
    ([ECB daily XML](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml)).
  - Hetzner's USD list is about 5% above EUR@ECB (302.10 / 257.30 = 1.174).
    With EUR billing, the $1,500 budget buys a fifth AX102-1.
- **VAT**: "All prices are excluding VAT" (price adjustment page). Hetzner's
  site VAT table applies 19% for Germany and 0% for "All others"
  ([live_data_vat.json](https://www.hetzner.com/_resources/app/data/app/live_data_vat.json)).
  Boat says checkout adds no VAT.
- **Setup fees** are one-time and are shown separately from the monthly
  budget. The table also amortises them over 12 months `[A]`. Server Auction
  units have no setup fee
  ([Auction FAQ](https://docs.hetzner.com/robot/general/server-auction-faqs/)).
- **Storage Box**: one BX31 (10 TB, €20.80 = $23.24 at ECB) for backups of
  suspended workspaces is taken off the top of each budget before buying
  servers.

### 2.3 Fleets that fit the budget (calculator output B1, USD list)

Server Auction units are the specific listings in Hetzner's live auction feed
on 2026-10-30, cheapest €/GiB first, with finite stock. "LTD" fleets assume
Hetzner's limited stock is available, which it does not promise (§5.2).

**$1,500/month**

| fleet | servers | threads | RAM GiB | NVMe TB raw | servers+IPv4 /mo | incl. Storage Box /mo | setup once | setup /12 mo |
|---|---|---|---|---|---|---|---|---|
| 4x AX102-1 | 4 | 128 | 512 | 15.36 | $1,216.00 | $1,239.24 | $596.00 | $49.67 |
| 2x AX102-3 | 2 | 64 | 256 | 7.68 | $1,068.00 | $1,091.24 | $528.00 | $44.00 |
| 2x AX162-1 | 2 | 192 | 256 | 15.36 | $1,448.00 | $1,471.24 | $718.00 | $59.83 |
| 1x AX162-2 | 1 | 96 | 256 | 3.84 | $994.00 | $1,017.24 | $494.00 | $41.17 |
| 2x EX131-1 | 2 | 128 | 256 | 7.68 | $1,338.00 | $1,361.24 | $668.00 | $55.67 |
| 12x AX42-1 | 12 | 192 | 768 | 12.29 | $1,428.00 | $1,451.24 | $708.00 | $59.00 |
| 7x AX102-1-LTD | 7 | 224 | 896 | 26.88 | $1,323.00 | $1,346.24 | $273.00 | $22.75 |
| 3x AX162-2-LTD | 3 | 288 | 768 | 11.52 | $1,122.00 | $1,145.24 | $117.00 | $9.75 |
| 1x AX162-2 + 1x AX102-1 | 2 | 128 | 384 | 7.68 | $1,298.00 | $1,321.24 | $643.00 | $53.58 |
| Server Auction (6 of 8 shortlisted units) | 6 | 84 | 832 | 12.00 | $1,124.40 | $1,147.64 | $0.00 | $0.00 |

**$2,000/month**

| fleet | servers | threads | RAM GiB | NVMe TB raw | servers+IPv4 /mo | incl. Storage Box /mo | setup once | setup /12 mo |
|---|---|---|---|---|---|---|---|---|
| 6x AX102-1 | 6 | 192 | 768 | 23.04 | $1,824.00 | $1,847.24 | $894.00 | $74.50 |
| 3x AX102-3 | 3 | 96 | 384 | 11.52 | $1,602.00 | $1,625.24 | $792.00 | $66.00 |
| 2x AX162-1 | 2 | 192 | 256 | 15.36 | $1,448.00 | $1,471.24 | $718.00 | $59.83 |
| 1x AX162-2 | 1 | 96 | 256 | 3.84 | $994.00 | $1,017.24 | $494.00 | $41.17 |
| 1x AX162-3 | 1 | 96 | 512 | 15.36 | $1,899.00 | $1,922.24 | $949.00 | $79.08 |
| 2x EX131-1 | 2 | 128 | 256 | 7.68 | $1,338.00 | $1,361.24 | $668.00 | $55.67 |
| 16x AX42-1 | 16 | 256 | 1024 | 16.38 | $1,904.00 | $1,927.24 | $944.00 | $78.67 |
| 10x AX102-1-LTD | 10 | 320 | 1280 | 38.40 | $1,890.00 | $1,913.24 | $390.00 | $32.50 |
| 5x AX162-2-LTD | 5 | 480 | 1280 | 19.20 | $1,870.00 | $1,893.24 | $195.00 | $16.25 |
| 1x AX162-2 + 3x AX102-1 | 4 | 192 | 640 | 15.36 | $1,906.00 | $1,929.24 | $941.00 | $78.42 |
| Server Auction (8 of 8 shortlisted units) | 8 | 148 | 1088 | 27.36 | $1,875.20 | $1,898.44 | $0.00 | $0.00 |

With **EUR@ECB** pricing the counts change slightly:

- $1,500 buys 5x AX102-1 ($1,446.77), 13x AX42-1, 8x AX102-1-LTD or 4x AX162-2-LTD.
- $2,000 buys 6x AX102-1 ($1,736.13), 17x AX42-1, 11x AX102-1-LTD or 5x AX162-2-LTD.

The script prints the full EUR@ECB tables.

### 2.4 Boat-size sandboxes per fleet (calculator output B2, USD list)

Each cell reads "without N+1 / with N+1 (binding limit)" and covers 1x, 2x and
4x CPU overcommit. The model:

- RAM at 1x, with 4 GiB + 6% of RAM reserved per host, 0.1 GiB VMM overhead
  per sandbox, and 16 GiB + 4 threads for the control plane on one host `[A]`.
- Disk thick-provisioned on RAID1/RAID10, less 100 GiB per host `[A]`.
- N+1 keeps the largest server empty as the spare.

**$1,500/month**

| fleet | shape | 1x CPU | 2x CPU | 4x CPU |
|---|---|---|---|---|
| 4x AX102-1 | Boat small | 58 / 43 (CPU) | 108 / 80 (RAM) | 108 / 80 (RAM) |
| 4x AX102-1 | Boat default | 27 / 20 (CPU) | 54 / 40 (RAM) | 54 / 40 (RAM) |
| 4x AX102-1 | Boat large | 12 / 9 (CPU) | 27 / 20 (RAM) | 27 / 20 (RAM) |
| 4x AX102-1 | Boat xlarge | 4 / 3 (CPU) | 12 / 9 (RAM) | 12 / 9 (RAM) |
| 2x AX102-3 | Boat small | 28 / 13 (CPU) | 52 / 24 (RAM) | 52 / 24 (RAM) |
| 2x AX102-3 | Boat default | 13 / 6 (CPU) | 26 / 12 (RAM) | 26 / 12 (RAM) |
| 2x AX102-3 | Boat large | 6 / 3 (CPU) | 13 / 6 (RAM) | 13 / 6 (RAM) |
| 2x AX102-3 | Boat xlarge | 2 / 1 (CPU) | 6 / 3 (RAM) | 6 / 3 (RAM) |
| 2x AX162-1 | Boat small | 52 / 24 (RAM) | 52 / 24 (RAM) | 52 / 24 (RAM) |
| 2x AX162-1 | Boat default | 26 / 12 (RAM) | 26 / 12 (RAM) | 26 / 12 (RAM) |
| 2x AX162-1 | Boat large | 13 / 6 (RAM) | 13 / 6 (RAM) | 13 / 6 (RAM) |
| 2x AX162-1 | Boat xlarge | 6 / 3 (RAM) | 6 / 3 (RAM) | 6 / 3 (RAM) |
| 1x AX162-2 | Boat small | 33 / 0 (disk) | 33 / 0 (disk) | 33 / 0 (disk) |
| 1x AX162-2 | Boat default | 22 / 0 (CPU) | 27 / 0 (RAM) | 27 / 0 (RAM) |
| 1x AX162-2 | Boat large | 11 / 0 (CPU) | 13 / 0 (RAM) | 13 / 0 (RAM) |
| 1x AX162-2 | Boat xlarge | 5 / 0 (CPU) | 6 / 0 (RAM) | 6 / 0 (RAM) |
| 2x EX131-1 | Boat small | 52 / 24 (RAM) | 52 / 24 (RAM) | 52 / 24 (RAM) |
| 2x EX131-1 | Boat default | 26 / 12 (RAM) | 26 / 12 (RAM) | 26 / 12 (RAM) |
| 2x EX131-1 | Boat large | 13 / 6 (RAM) | 13 / 6 (RAM) | 13 / 6 (RAM) |
| 2x EX131-1 | Boat xlarge | 6 / 3 (RAM) | 6 / 3 (RAM) | 6 / 3 (RAM) |
| 12x AX42-1 | Boat small | 82 / 75 (CPU) | 84 / 77 (disk) | 84 / 77 (disk) |
| 12x AX42-1 | Boat default | 35 / 32 (CPU) | 70 / 64 (RAM) | 70 / 64 (RAM) |
| 12x AX42-1 | Boat large | 12 / 11 (CPU) | 35 / 32 (RAM) | 35 / 32 (RAM) |
| 12x AX42-1 | Boat xlarge | 0 / 0 (CPU) | 12 / 11 (RAM) | 12 / 11 (RAM) |
| 7x AX102-1-LTD | Boat small | 103 / 88 (CPU) | 192 / 164 (RAM) | 192 / 164 (RAM) |
| 7x AX102-1-LTD | Boat default | 48 / 41 (CPU) | 96 / 82 (RAM) | 96 / 82 (RAM) |
| 7x AX102-1-LTD | Boat large | 21 / 18 (CPU) | 48 / 41 (RAM) | 48 / 41 (RAM) |
| 7x AX102-1-LTD | Boat xlarge | 7 / 6 (CPU) | 21 / 18 (RAM) | 21 / 18 (RAM) |
| 3x AX162-2-LTD | Boat small | 99 / 66 (disk) | 99 / 66 (disk) | 99 / 66 (disk) |
| 3x AX162-2-LTD | Boat default | 68 / 45 (CPU) | 85 / 56 (RAM) | 85 / 56 (RAM) |
| 3x AX162-2-LTD | Boat large | 33 / 22 (CPU) | 41 / 27 (RAM) | 41 / 27 (RAM) |
| 3x AX162-2-LTD | Boat xlarge | 15 / 10 (CPU) | 18 / 12 (RAM/disk) | 18 / 12 (RAM/disk) |
| 1x AX162-2 + 1x AX102-1 | Boat small | 48 / 13 (CPU/disk) | 61 / 24 (RAM/disk) | 61 / 24 (RAM/disk) |
| 1x AX162-2 + 1x AX102-1 | Boat default | 29 / 6 (CPU) | 41 / 12 (RAM) | 41 / 12 (RAM) |
| 1x AX162-2 + 1x AX102-1 | Boat large | 14 / 3 (CPU) | 20 / 6 (RAM) | 20 / 6 (RAM) |
| 1x AX162-2 + 1x AX102-1 | Boat xlarge | 6 / 1 (CPU) | 9 / 3 (RAM) | 9 / 3 (RAM) |
| Server Auction (6 of 8 shortlisted units) | Boat small | 34 / 27 (CPU) | 68 / 54 (CPU) | 92 / 76 (CPU/disk) |
| Server Auction (6 of 8 shortlisted units) | Boat default | 14 / 11 (CPU) | 34 / 27 (CPU) | 68 / 54 (CPU/RAM) |
| Server Auction (6 of 8 shortlisted units) | Boat large | 5 / 4 (CPU) | 14 / 11 (CPU) | 34 / 27 (CPU/RAM) |
| Server Auction (6 of 8 shortlisted units) | Boat xlarge | 0 / 0 (CPU) | 5 / 4 (CPU) | 14 / 11 (CPU/RAM) |

**$2,000/month**

| fleet | shape | 1x CPU | 2x CPU | 4x CPU |
|---|---|---|---|---|
| 6x AX102-1 | Boat small | 88 / 73 (CPU) | 164 / 136 (RAM) | 164 / 136 (RAM) |
| 6x AX102-1 | Boat default | 41 / 34 (CPU) | 82 / 68 (RAM) | 82 / 68 (RAM) |
| 6x AX102-1 | Boat large | 18 / 15 (CPU) | 41 / 34 (RAM) | 41 / 34 (RAM) |
| 6x AX102-1 | Boat xlarge | 6 / 5 (CPU) | 18 / 15 (RAM) | 18 / 15 (RAM) |
| 3x AX102-3 | Boat small | 43 / 28 (CPU) | 80 / 52 (RAM) | 80 / 52 (RAM) |
| 3x AX102-3 | Boat default | 20 / 13 (CPU) | 40 / 26 (RAM) | 40 / 26 (RAM) |
| 3x AX102-3 | Boat large | 9 / 6 (CPU) | 20 / 13 (RAM) | 20 / 13 (RAM) |
| 3x AX102-3 | Boat xlarge | 3 / 2 (CPU) | 9 / 6 (RAM) | 9 / 6 (RAM) |
| 2x AX162-1 | Boat small | 52 / 24 (RAM) | 52 / 24 (RAM) | 52 / 24 (RAM) |
| 2x AX162-1 | Boat default | 26 / 12 (RAM) | 26 / 12 (RAM) | 26 / 12 (RAM) |
| 2x AX162-1 | Boat large | 13 / 6 (RAM) | 13 / 6 (RAM) | 13 / 6 (RAM) |
| 2x AX162-1 | Boat xlarge | 6 / 3 (RAM) | 6 / 3 (RAM) | 6 / 3 (RAM) |
| 1x AX162-2 | Boat small | 33 / 0 (disk) | 33 / 0 (disk) | 33 / 0 (disk) |
| 1x AX162-2 | Boat default | 22 / 0 (CPU) | 27 / 0 (RAM) | 27 / 0 (RAM) |
| 1x AX162-2 | Boat large | 11 / 0 (CPU) | 13 / 0 (RAM) | 13 / 0 (RAM) |
| 1x AX162-2 | Boat xlarge | 5 / 0 (CPU) | 6 / 0 (RAM) | 6 / 0 (RAM) |
| 1x AX162-3 | Boat small | 45 / 0 (CPU) | 90 / 0 (CPU) | 112 / 0 (RAM) |
| 1x AX162-3 | Boat default | 22 / 0 (CPU) | 45 / 0 (CPU) | 56 / 0 (RAM) |
| 1x AX162-3 | Boat large | 11 / 0 (CPU) | 22 / 0 (CPU) | 28 / 0 (RAM) |
| 1x AX162-3 | Boat xlarge | 5 / 0 (CPU) | 11 / 0 (CPU) | 14 / 0 (RAM) |
| 2x EX131-1 | Boat small | 52 / 24 (RAM) | 52 / 24 (RAM) | 52 / 24 (RAM) |
| 2x EX131-1 | Boat default | 26 / 12 (RAM) | 26 / 12 (RAM) | 26 / 12 (RAM) |
| 2x EX131-1 | Boat large | 13 / 6 (RAM) | 13 / 6 (RAM) | 13 / 6 (RAM) |
| 2x EX131-1 | Boat xlarge | 6 / 3 (RAM) | 6 / 3 (RAM) | 6 / 3 (RAM) |
| 16x AX42-1 | Boat small | 110 / 103 (CPU) | 112 / 105 (disk) | 112 / 105 (disk) |
| 16x AX42-1 | Boat default | 47 / 44 (CPU) | 94 / 88 (RAM) | 94 / 88 (RAM) |
| 16x AX42-1 | Boat large | 16 / 15 (CPU) | 47 / 44 (RAM) | 47 / 44 (RAM) |
| 16x AX42-1 | Boat xlarge | 0 / 0 (CPU) | 16 / 15 (RAM) | 16 / 15 (RAM) |
| 10x AX102-1-LTD | Boat small | 148 / 133 (CPU) | 276 / 248 (RAM) | 276 / 248 (RAM) |
| 10x AX102-1-LTD | Boat default | 69 / 62 (CPU) | 138 / 124 (RAM) | 138 / 124 (RAM) |
| 10x AX102-1-LTD | Boat large | 30 / 27 (CPU) | 69 / 62 (RAM) | 69 / 62 (RAM) |
| 10x AX102-1-LTD | Boat xlarge | 10 / 9 (CPU) | 30 / 27 (RAM) | 30 / 27 (RAM) |
| 5x AX162-2-LTD | Boat small | 165 / 132 (disk) | 165 / 132 (disk) | 165 / 132 (disk) |
| 5x AX162-2-LTD | Boat default | 114 / 91 (CPU) | 143 / 114 (RAM) | 143 / 114 (RAM) |
| 5x AX162-2-LTD | Boat large | 55 / 44 (CPU) | 69 / 55 (RAM) | 69 / 55 (RAM) |
| 5x AX162-2-LTD | Boat xlarge | 25 / 20 (CPU) | 30 / 24 (RAM/disk) | 30 / 24 (RAM/disk) |
| 1x AX162-2 + 3x AX102-1 | Boat small | 78 / 43 (CPU/disk) | 117 / 80 (RAM/disk) | 117 / 80 (RAM/disk) |
| 1x AX162-2 + 3x AX102-1 | Boat default | 43 / 20 (CPU) | 69 / 40 (RAM) | 69 / 40 (RAM) |
| 1x AX162-2 + 3x AX102-1 | Boat large | 20 / 9 (CPU) | 34 / 20 (RAM) | 34 / 20 (RAM) |
| 1x AX162-2 + 3x AX102-1 | Boat xlarge | 8 / 3 (CPU) | 15 / 9 (RAM) | 15 / 9 (RAM) |
| Server Auction (8 of 8 shortlisted units) | Boat small | 64 / 49 (CPU) | 124 / 96 (CPU/RAM) | 148 / 120 (CPU/RAM/disk) |
| Server Auction (8 of 8 shortlisted units) | Boat default | 28 / 21 (CPU) | 62 / 48 (CPU/RAM) | 96 / 82 (CPU/RAM) |
| Server Auction (8 of 8 shortlisted units) | Boat large | 11 / 8 (CPU) | 28 / 21 (CPU/RAM) | 48 / 41 (CPU/RAM) |
| Server Auction (8 of 8 shortlisted units) | Boat xlarge | 2 / 1 (CPU) | 11 / 8 (CPU/RAM) | 20 / 17 (CPU/RAM) |

**How to read these tables:**

- **RAM binds** on every new-server fleet once CPU is overcommitted 2x or
  more. 2x and 4x give the same count.
- **CPU binds at 1x.** It also binds on the old auction CPUs, which have
  12–16 threads per 128 GB.
- **Disk binds** for Boat `small` (51 GB each) on servers with small NVMe:
  AX42-1 has 2x512 GB, and AX162-2 / AX162-2-LTD have 2x1.92 TB for 256 GB of
  RAM.
- **Single-server fleets** (1x AX162-2, 1x AX162-3) have no N+1 at all.

### 2.5 Hetzner vs Boat for the same money (Boat sizes)

Hetzner counts are concurrent sandboxes at 2x CPU and 1x RAM, shown as with
N+1 (without). Boat counts are from calculator output B3:

- "always-on" = concurrent sandboxes running 730 h/month.
- "U1 seats" = seats running 173.3 h/month each, all at the same time.

| Budget | Boat size | 4x / 6x AX102-1 (USD list) | 5x / 6x AX102-1 (EUR@ECB) | 7x / 10x AX102-1-LTD | 12x / 16x AX42-1 | Boat always-on | Boat U1 seats |
|---|---|---|---|---|---|---|---|
| $1,500 | `small` | 80 (108) | 108 (136) | 164 (192) | 77 (84) | **114** | **480** |
| $1,500 | `default` | 40 (54) | 54 (68) | 82 (96) | 64 (70) | **57** | **240** |
| $1,500 | `large` | 20 (27) | 27 (34) | 41 (48) | 32 (35) | **28** | **120** |
| $1,500 | `xlarge` | 9 (12) | 12 (15) | 18 (21) | 11 (12) | **10** | **43** |
| $2,000 | `small` | 136 (164) | 136 (164) | 248 (276) | 105 (112) | **152** | **641** |
| $2,000 | `default` | 68 (82) | 68 (82) | 124 (138) | 88 (94) | **76** | **320** |
| $2,000 | `large` | 34 (41) | 34 (41) | 62 (69) | 44 (47) | **38** | **160** |
| $2,000 | `xlarge` | 15 (18) | 15 (18) | 27 (30) | 15 (16) | **13** | **57** |

**Reading:**

- **Always-on.** With no engineering counted:
  - a list-price Hetzner fleet with N+1 hosts 70–90% of Boat's always-on
    count (115% for `xlarge` at $2,000);
  - without N+1 it hosts 95–138%;
  - LTD fleets with N+1 host 144–208%.

  The hardware is roughly at parity; the engineering is extra.
- **TerminalX's pattern.** Boat bills only running seconds, so the same money
  funds about 4.2x more seats (730 / 173.3). A Hetzner fleet is paid for at
  peak capacity whether seats run or not. It could only close that gap if
  seats were spread across time zones, so that peak concurrency falls below
  the number of seats.
- **Boat's plan limit.** At $1,500 Boat sits on the $500 plan, which allows
  1,000 concurrent. Neither budget reaches the limit.

**Sensitivity.** With thin disk (2x), RAM 1.25x and CPU 4x, 4x AX102-1 hosts
100 `small` / 49 `default` with N+1 (B4). With "Boat-like" overcommit (RAM 2x,
disk 2x, CPU 4x) it hosts 160 / 80 with N+1 (B5), which beats Boat always-on.
RAM overcommit above 1x needs ballooning or free-page reporting and accepts
OOM risk. Boat's own published RAM use (median 18.89%) suggests Boat
overcommits RAM, but Boat does not say so.

| fleet | Boat small | Boat default | Boat large | Boat xlarge |
|---|---|---|---|---|
| 4x AX102-1 | 135 / 100 (RAM) | 66 / 49 (RAM) | 34 / 25 (RAM) | 15 / 11 (RAM) |
| 2x AX102-3 | 65 / 30 (RAM) | 32 / 15 (RAM) | 16 / 7 (RAM) | 7 / 3 (RAM) |
| 2x AX162-1 | 65 / 30 (RAM) | 32 / 15 (RAM) | 16 / 7 (RAM) | 7 / 3 (RAM) |
| 1x AX162-2 | 66 / 0 (disk) | 34 / 0 (RAM) | 17 / 0 (RAM) | 8 / 0 (RAM) |
| 2x EX131-1 | 65 / 30 (RAM) | 32 / 15 (RAM) | 16 / 7 (RAM) | 7 / 3 (RAM) |
| 12x AX42-1 | 166 / 152 (RAM/disk) | 94 / 86 (RAM) | 47 / 43 (RAM) | 23 / 21 (RAM) |
| 7x AX102-1-LTD | 240 / 205 (RAM) | 117 / 100 (RAM) | 61 / 52 (RAM) | 27 / 23 (RAM) |
| 3x AX162-2-LTD | 198 / 132 (disk) | 106 / 70 (RAM) | 53 / 35 (RAM) | 26 / 17 (RAM) |
| 1x AX162-2 + 1x AX102-1 | 101 / 30 (RAM/disk) | 51 / 15 (RAM) | 26 / 7 (RAM) | 12 / 3 (RAM) |
| Server Auction (6 of 8 shortlisted units) | 136 / 108 (CPU) | 68 / 54 (CPU) | 34 / 27 (CPU) | 14 / 11 (CPU) |

| budget | fleet | Boat small | Boat default | Boat large | Boat xlarge |
|---|---|---|---|---|---|
| $1,500 | 4x AX102-1 | 216 / 160 (RAM) | 108 / 80 (RAM) | 54 / 40 (RAM) | 27 / 20 (RAM) |
| $1,500 | 3x AX162-2-LTD | 198 / 132 (disk) | 170 / 112 (RAM) | 85 / 56 (RAM) | 39 / 26 (RAM/disk) |
| $1,500 | 1x AX162-2 + 1x AX102-1 | 122 / 48 (RAM/disk) | 82 / 24 (RAM) | 41 / 12 (RAM) | 20 / 6 (RAM) |
| $2,000 | 6x AX102-1 | 328 / 272 (RAM) | 164 / 136 (RAM) | 82 / 68 (RAM) | 41 / 34 (RAM) |
| $2,000 | 5x AX162-2-LTD | 330 / 264 (disk) | 286 / 228 (RAM) | 143 / 114 (RAM) | 65 / 52 (RAM/disk) |
| $2,000 | 1x AX162-2 + 3x AX102-1 | 234 / 160 (RAM/disk) | 138 / 80 (RAM) | 69 / 40 (RAM) | 34 / 20 (RAM) |

### 2.6 Other providers for the same money (secondary; calculator output B3)

Profile A is matched by InstaBox's 2/4 size. For Boxd, the size with the same
vCPU is used and RAM is billed as resident = profile RAM. Cua is omitted: it
sells no compute now ([cua.ai/pricing](https://cua.ai/pricing): "You bring the
computers; Cua doesn't rent them").

| Budget | Shape | Provider | $/h | Concurrent always-on | Seats at U1 |
|---|---|---|---|---|---|
| $1,500 | Profile A | InstaBox | 0.0170 | 120 | 500 (Team-plan cap) |
| $1,500 | Profile A | Boxd | 0.1519 | 13 | 54 |
| $1,500 | Profile A | E2B | 0.1656 | 11 | 47 |
| $1,500 | Profile A | Daytona | 0.1672 | 12 | 50 |
| $1,500 | Profile B | InstaBox | 0.0362 | 56 | 200 |
| $1,500 | Profile B | Boxd | 0.3038 | 6 | 27 |
| $1,500 | Profile B | E2B | 0.3312 | 5 | 23 |
| $1,500 | Profile B | Daytona | 0.3350 | 6 | 24 |
| $2,000 | Profile A | InstaBox | 0.0170 | 161 | 500 (Team-plan cap) |
| $2,000 | Profile A | Boxd | 0.1519 | 18 | 72 |
| $2,000 | Profile A | E2B | 0.1656 | 15 | 64 |
| $2,000 | Profile A | Daytona | 0.1672 | 16 | 66 |
| $2,000 | Profile B | InstaBox | 0.0362 | 75 | 266 |
| $2,000 | Profile B | Boxd | 0.3038 | 9 | 36 |
| $2,000 | Profile B | E2B | 0.3312 | 7 | 32 |
| $2,000 | Profile B | Daytona | 0.3350 | 8 | 33 |

For comparison, Hetzner at $1,500 (4x AX102-1, N+1) gives 80 Profile A or 40
Profile B concurrent. At $2,000 (6x AX102-1, N+1) it gives 136 or 68.

### 2.7 Which Hetzner server is cheapest per sandbox (re-checked 2026-11-01)

This section re-checks prices and add-on rules on 2026-11-01. It ranks every
current server type, plus the auction boxes that can take add-ons, by monthly
cost per Boat-size sandbox. The calculator is in Appendix B.

**What can be added to which server**

- **New AX and EX servers take no RAM or drive add-ons.**
  - The server-line docs say: "AX server types are configured with fixed
    hardware, varying the number of drives and RAM capacity. You cannot order
    additional hardware; instead, you must upgrade to a different server model
    to obtain more drives or RAM"
    ([ax-server](https://docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/),
    changed 2026-10-21; the same wording is on
    [ex-server](https://docs.hetzner.com/robot/dedicated-server/server-lines/ex-server/)).
  - The configurator says: "Server types offer fixed hardware configurations
    that cannot be modified after ordering"
    ([AX162 configurator](https://www.hetzner.com/dedicated-rootserver/ax162/configurator/)).
  - The product files' `Addon` list is empty for AX41, AX42, AX102, AX162,
    EX44, EX63 and EX131 (`product/<MODEL>_en.json`).
  - More RAM or disk therefore means a bigger variant: AX102-2, AX162-2/-3/-4,
    EX131-2/-3. Only network cards and uplinks can still be added.
- **Server Auction boxes do take add-ons**, after delivery: "once we provide
  you with the server, you can request additional hardware via a support
  request in Robot". Hetzner also warns: "certain hardware may not be
  compatible … clarify any requirements … with our product advisors before
  placing your order"
  ([Auction FAQ](https://docs.hetzner.com/robot/general/server-auction-faqs/)).
  Installation "usually takes 30-60 minutes"
  ([hardware overview](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/dedicated-server-hardware-overview/)).
- **Add-on prices**, monthly, from the
  [add-on price list](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/)
  (changed 2026-10-07):
  - DDR4 Reg. ECC RAM: $22 per 32 GB step, or $39 per 64 GB step.
  - DDR5 Reg. ECC RAM: $81 per 32 GB, $131 per 64 GB, or $225 per 96 GB.
  - NVMe Datacenter Edition drives: 0.96 / 1.92 / 3.84 / 7.68 TB at
    $45 / $83 / $114 / $201.
- **The auction box this helps is the AX161.**
  - It has an AMD EPYC 7502P (Zen 2, "32 cores and Simultaneous
    Multithreading", so 64 threads) and room for up to 8 disks
    ([archived AX161 page, 2024-02-23](https://web.archive.org/web/20240223120235/https://www.hetzner.com/dedicated-rootserver/ax161/)).
  - It takes "RAM-Upgrade per 32 GB DDR4 Reg. ECC steps max. 512 GB" and
    "8x 960 GB - 7.68 TB NVMe DC Edition SSD" (ax-server).
  - The live auction feed on 2026-11-01 listed **five AX161 units** at
    $381–$530 a month. Each has 128 GB, and auction servers have no setup fee
    ([live_data_sb.json](https://www.hetzner.com/_resources/app/data/app/live_data_sb.json)).
- **No other auction box in the list is worth upgrading:**
  - The 5950X (AX101) takes "no additional RAM".
  - The Ryzen 7 7700 (AX52) costs $375 a month to go from 64 GB to 192 GB.
  - The i7-8700 and E5-1650 v3 have only 12 threads.
- **The LTD tier is not in the shop today.**
  - Hetzner's per-product API still prices AX162-2-LTD at $372.10 and
    AX102-1-LTD at $187.10 (`website-price-api.hetzner.com/api/v1/products/ROBOT_1757`,
    `…/ROBOT_1723`).
  - But no LTD product ID (ROBOT_1720, 1723, 1727, 1732, 1736, 1757, 1758,
    1760, 1762) is in the shop's live price feed
    ([live_data_prices.json](https://www.hetzner.com/_resources/app/data/app/live_data_prices.json)).
  - The AX162 configurator lists only AX162-1, -2, -3 and -4.
  - So plan on list prices. The LTD fleets in §2.3–§2.5 and §7 apply only if
    Hetzner sells LTD again.

**Model**

- Same parameters as §7.1: RAM at 1x, a host reserve of 4 GiB + 6%, 0.1 GiB
  VMM overhead, 2 host threads, RAID1 and a 100 GB OS reserve.
- **"thick"** reserves Boat's full 51 GB per sandbox. **"thin"** overcommits
  disk 2x with sparse images `[A]`.
- **CPU at 4x** is backed by Boat's published average of 11.11% CPU busy:
  4 × 11% ≈ 44% host load `[A]`.
- **AX161 add-ons:** for each unit the script picks the RAM and drives that
  minimise $/sandbox. It uses 32 GB steps up to 512 GB. 1 TB with 64 GB
  modules is not modelled, because the price list does not say what swapping
  the four 32 GB base modules costs.

**Summary matrix** (Appendix B output). Each cell is $ per sandbox-month,
including IPv4, add-ons and setup ÷ 12, with sandboxes per server in brackets.
The second column is $ per GB of RAM a month; for the AX161 it is the cheapest
unit upgraded to 512 GB, before drives.

| server | $/GB RAM-month | small 4x CPU thick | small 4x CPU thin | small 2x CPU thick | small 2x CPU thin | default 4x CPU thick | default 2x CPU thick |
|---|---|---|---|---|---|---|---|
| **AX161 auction (best unit)** | **1.26** | **8.62 (109)** | **6.86 (116)** | **10.35 (62)** | **10.32 (62)** | **13.72 (58)** | **20.64 (31)** |
| AX42-1 | 1.86 | 15.49 (8) | 9.53 (13) | 15.49 (8) | 9.53 (13) | 20.65 (6) | 20.65 (6) |
| **AX102-1** | 2.38 | **11.30 (28)** | 11.30 (28) | 11.30 (28) | 11.30 (28) | 22.60 (14) | 22.60 (14) |
| EX63-1 | 2.72 | 13.92 (13) | 13.92 (13) | 13.92 (13) | 13.92 (13) | 30.17 (6) | 30.17 (6) |
| EX63-2 | 3.30 | 18.86 (35) | 18.34 (36) | 36.68 (18) | 36.68 (18) | 36.68 (18) | 73.35 (9) |
| AX102-2 | 3.35 | 19.16 (35) | 15.59 (43) | 22.35 (30) | 22.35 (30) | 31.93 (21) | 44.71 (15) |
| AX162-3 | 3.71 | 17.05 (116) | 17.05 (116) | 21.04 (94) | 21.04 (94) | 34.10 (58) | 42.09 (47) |
| AX162-2 | 3.88 | 29.58 (35) | 18.16 (57) | 29.58 (35) | 18.16 (57) | 35.70 (29) | 35.70 (29) |
| AX162-4 | 5.07 | 23.74 (57) | 23.74 (57) | 23.74 (57) | 23.74 (57) | 46.66 (29) | 46.66 (29) |
| EX131-2 | 5.07 | 23.74 (57) | 23.74 (57) | 23.74 (57) | 23.74 (57) | 46.66 (29) | 46.66 (29) |
| EX131-1 | 5.23 | 24.89 (28) | 24.89 (28) | 24.89 (28) | 24.89 (28) | 49.77 (14) | 49.77 (14) |
| AX162-1 | 5.66 | 26.93 (28) | 26.93 (28) | 26.93 (28) | 26.93 (28) | 53.85 (14) | 53.85 (14) |
| AX102-4 | 6.98 | 33.26 (28) | 33.26 (28) | 33.26 (28) | 33.26 (28) | 66.53 (14) | 66.53 (14) |

Boat `small` running all month costs $13.14 (0.018 × 730), and `default`
costs $26.28.

**How to read it**

1. **RAM is the binding resource, so the price per GB decides.**
   - DDR4 Reg. ECC added to an auction AX161 costs $0.69 per GB a month.
   - New DDR5 servers cost $1.86–6.98 per GB, after Hetzner's 2026 increases
     (§5.2).
2. **Cheapest per sandbox: an auction AX161 upgraded to 480–512 GB.**
   - At 4x CPU it costs $6.86–8.62 per `small` and $13.72 per `default`.
     That is 116 / 58 per box (109 `small` with thick disk).
   - This is 24–39% below AX102-1 and 34–48% below Boat running all month.
   - At 2x CPU it is CPU-bound at 62 `small`, and roughly ties AX102-1.
3. **Best new server: AX102-1** at $11.30 per `small`, the same in every
   scenario.
   - It is RAM-bound at 28 sandboxes, and its 2x1.92 TB holds 35 thick.
   - Its Zen 4 7950X3D is the nearest in this list to Boat's own Ryzen 9 9950X
     hosts (§2.1).
4. **AX42-1 is cheap only with thin disk** ($9.53, 13 `small`).
   - Its 2x512 GB holds 8 thick `small`, and drives cannot be added.
   - It has 64 GB of non-ECC RAM.
   - Many small boxes give the best count after losing one server (below).
5. **Avoid the big new servers.** AX162-x, EX131-x, AX102-2/-3/-4 and EX63-2
   cost $15–67 per sandbox.

**Best fleet per budget** (Appendix B output; CPU 4x, RAM 1x)

- The search allows any count of up to two new server types plus any subset
  of the five AX161 units.
- "max count" maximises the total number of sandboxes.
- "with spare" maximises the number left after losing the largest server.

| budget | shape | disk | goal | fleet | sandboxes | after losing largest server | $/month | setup once |
|---|---|---|---|---|---|---|---|---|
| $1,500 | Boat small | thick | max count | 1x AX161 (+RAM to 480 GB, +2x1.92 TB) + 2x AX42-1 + 1x AX102-1 | 153 | 44 | 1,481.90 | 267.00 |
| $1,500 | Boat small | thick | with spare | 2x AX42-1 + 4x AX102-1 | 128 | 100 | 1,454.00 | 714.00 |
| $1,500 | Boat small | thin 2x | max count | 1x AX161 (+RAM to 512 GB) + 3x AX42-1 + 1x AX102-1 | 183 | 67 | 1,456.90 | 326.00 |
| $1,500 | Boat small | thin 2x | with spare | 12x AX42-1 | 156 | 143 | 1,428.00 | 708.00 |
| $1,500 | Boat default | thick | max count | 1x AX161 (+RAM to 512 GB) + 3x AX42-1 + 1x AX102-1 | 90 | 32 | 1,456.90 | 326.00 |
| $1,500 | Boat default | thick | with spare | 12x AX42-1 | 72 | 66 | 1,428.00 | 708.00 |
| $2,000 | Boat small | thick | max count | 2x AX161 (+RAM to 512 / 480 GB, +2x7.68 / 2x1.92 TB) | 225 | 109 | 1,988.80 | 0.00 |
| $2,000 | Boat small | thick | with spare | 6x AX102-1 + 1x EX63-1 | 181 | 153 | 1,998.00 | 978.00 |
| $2,000 | Boat small | thin 2x | max count | 2x AX161 (+RAM to 512 GB, +2x3.84 TB on one) + 1x AX102-1 | 260 | 144 | 1,974.80 | 149.00 |
| $2,000 | Boat small | thin 2x | with spare | 16x AX42-1 | 208 | 195 | 1,904.00 | 944.00 |
| $2,000 | Boat default | thick | max count | 2x AX161 (+RAM to 512 GB, +2x3.84 TB on one) + 1x AX102-1 | 130 | 72 | 1,974.80 | 149.00 |
| $2,000 | Boat default | thick | with spare | 16x AX42-1 | 96 | 90 | 1,904.00 | 944.00 |

For the same money, Boat runs these all month (§2.5):

- **$1,500:** 114 `small` or 57 `default`.
- **$2,000:** 152 `small` or 76 `default`.

So at full occupancy the best Hetzner fleets host 12–71% more than Boat. That
counts hardware only, with no engineering time.

**Utilisation needed to match Boat `small`** (slot cost ÷ $13.14):

| Server and scenario | Break-even utilisation |
|---|---|
| AX161, thin disk, 4x CPU | 52% |
| AX161, thick disk, 4x CPU | 66% |
| AX42-1, thin disk | 73% |
| AX161, 2x CPU | 79% |
| AX102-1 | 86% |

Under TerminalX's 8-hours-per-weekday pattern (23.7%), every option costs
2.2–3.6x Boat per active hour. The recommendation in §1 does not change.

**Caveats for the AX161 route**

- **Slower cores.** The EPYC 7502P is a 2019 Zen 2 part at 2.5 GHz base, so
  each vCPU is slower than on AX102-1's 7950X3D or Boat's 9950X. A
  "Boat `small`" on it means two slower vCPUs. This note has no primary
  benchmark to put a number on it.
- **Large blast radius.** One box carries 109–116 sandboxes, so N+1 means a
  second AX161 standing by. E2B Embed's limit of 200 running sandboxes per
  node (§4) is not reached.
- **Uncertain supply.** Auction stock is finite (five units on 2026-11-01).
  Prices fall over time and units disappear.
- **Confirm before ordering.** Hetzner must confirm that the RAM and drive
  add-ons fit the specific unit.

---

## 3. Context: the workload and today's providers

- TerminalX launches cloud workspaces on several providers (`src-tauri/src/cloud_workspaces.rs:23`):
  - Boat (`box`);
  - Hetzner Cloud VMs, using the customer's API key;
  - Machine0, hidden since 2026-10-17 (`docs/CLOUD-LIFECYCLE.md`, `src/lib/hiddenProviders.ts`);
  - Local Docker, in debug builds only.
- **Organisation policy** caps workspaces, running workspaces, creates per hour
  and per day, and the idle-suspend interval (`src/lib/organizationCompute.ts`).
- **Resume is a cold boot** on Boat, Hetzner and Machine0:
  `preservesProcessesOnResume` is `false`. Files come back; running programs
  and terminals do not (`docs/CLOUD-LIFECYCLE.md`).
- **No Environment images** on Boat, Hetzner or Machine0, so repositories are
  cloned at launch (`docs/CLOUD-AGENT-TABS.md`, "Cloning at launch").
- **The workload:** Claude Code or Codex CLI in a Linux box with git
  checkouts and terminals, sometimes a desktop. Sessions last hours, suspend
  when idle and resume later. That is why §7 models both an 8 h/weekday
  pattern and always-on.

## 4. Part 1: open-source sandbox platforms you can self-host

**Hetzner KVM availability**

- **Hetzner Cloud VMs cannot run KVM guests.** The Cloud FAQ asks "Can I run
  virtual machines on cloud servers, or rather is nested virtualization
  possible?" and answers "No, this is not possible on cloud server"
  ([docs.hetzner.com/cloud/servers/faq](https://docs.hetzner.com/cloud/servers/faq/)).
  Cua's docs say the same: "Hetzner Cloud servers have no `/dev/kvm`"
  ([your-cloud.mdx](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-sdk/guides/your-cloud.mdx)).
- **Dedicated AX and EX servers list virtualization in their specs.** The AX
  matrix shows "Virtualization (AMD-V)" for every model
  ([matrix-ax](https://www.hetzner.com/dedicated-rootserver/matrix-ax/)), and
  the EX matrix shows "Virtualization (Intel-VT)"
  ([matrix-ex](https://www.hetzner.com/dedicated-rootserver/matrix-ex/)).
- So Firecracker, Cloud Hypervisor, Kata and QEMU/KVM need dedicated servers.
  On Hetzner Cloud only gVisor (systrap) or plain containers work.

**Columns below:** "90d" is commits on the default branch since 2026-08-01, from
the GitHub API. Latest release dates are from `gh api …/releases/latest`.

### 4.1 Summary table

| Platform | License (paid-only parts) | Isolation | Needs `/dev/kvm` | Suspend keeps memory? | What self-hosting gives you / what you build | Latest release · 90d commits | Verdict for TerminalX |
|---|---|---|---|---|---|---|---|
| **E2B Runtime** ([e2b-dev/runtime](https://github.com/e2b-dev/runtime), formerly `e2b-dev/infra`) | Apache-2.0; private cloud and BYOC are E2B commercial offerings | Firecracker microVM per sandbox; memory via userfaultfd, CoW rootfs | Yes. Kernel ≥6.8, `nbd`, cgroup v2, hugepages | **Yes**: pause diffs memory and disk; auto-pause and wake on traffic | **Single-node "Embed" only.** Multi-node deploy deleted 2026-09-10. You build placement across nodes, TLS, wildcard ports, multi-tenant auth and backups | `2026.30` (2026-09-10) · 889 | Best per-node fit; most build work above one node |
| **Daytona** ([daytonaio/daytona](https://github.com/daytonaio/daytona)) | AGPL-3.0 (v0.190.0). Repo **archived**: "core development has moved to a private codebase". Helm charts are Elastic-2.0 and attach to Daytona's control plane | Sysbox containers (OSS runner); VM runner not in the OSS code | No (Sysbox) | Only on the closed VM runner | Compose stack is "not safe to use in production" | v0.190.0 (2026-06-23) · 0 | Avoid |
| **Cua** ([trycua/cua](https://github.com/trycua/cua)) | MIT: SDK, CLI, daemon, Cua Driver, Lume. FSL-1.1-MIT: spacesd, Keyvault, Volume ("no competing hosted service") | Local: gVisor or runc containers, QEMU VMs, Firecracker `microvm`; Lume is Apple Silicon only | For VMs | Local only; what it preserves is not documented | **No hosted orchestrator.** Cua Cloud and Fleets ended 2026-10-18 | `cua-spaces-v0.19.1` (2026-10-30) · 1,996 | Use only the desktop images and driver |
| **Microsandbox** ([superradcompany/microsandbox](https://github.com/superradcompany/microsandbox)) | Apache-2.0 ("still beta software") | libkrun microVM | Yes | Local pause in memory; full snapshots local | Embedded library; "No setup server" | v0.7.11 (2026-10-24) · 550 | Library under your own control plane |
| **OpenSandbox** ([opensandbox-group/OpenSandbox](https://github.com/opensandbox-group/OpenSandbox), formerly `alibaba/OpenSandbox`) | Apache-2.0 | Docker or Kubernetes; gVisor, Kata, Firecracker via the young `fast-sandbox` repo (no releases) | For Kata/Firecracker | Firecracker path yes. Measured same-node resume **62.66 s** | Server plus k8s operator; you run k8s and storage | release-1.2.0 (2026-10-27) · 2,066 | Only if committing to k8s |
| **kubernetes-sigs/agent-sandbox** ([repo](https://github.com/kubernetes-sigs/agent-sandbox)) | Apache-2.0 | `RuntimeClass` (gVisor or Kata) | Kata yes | **No**: suspend deletes the Pod and keeps volumes | CRDs, warm pools and router; you run k8s | v1.0.9 (2026-10-29) · 498 | Only if committing to k8s |
| **Arrakis** ([abshkbh/arrakis](https://github.com/abshkbh/arrakis)) | AGPL-3.0 | Cloud Hypervisor | Yes | Yes (snapshot/restore) | Single host REST API, VNC | release-36 (2025-06-02) · 0 | Stale |
| **Coder** ([coder/coder](https://github.com/coder/coder)) | AGPL-3.0. `enterprise/` is source-available; Premium covers dormancy, quotas, prebuilds and port-sharing controls | Whatever the Terraform template creates | Depends | Depends on the provider (Incus can) | Control plane: users/OIDC, templates, auto-stop, agent with PTY/SSH/ports, **wildcard preview URLs** | v2.37.8 (2026-10-28) · 1,996 | Mature control plane |
| **Incus** ([lxc/incus](https://github.com/lxc/incus)) | Apache-2.0 | QEMU/KVM VMs and LXC | For VMs | **Yes** for VMs: `--stateful` stop/snapshot, live migration | Clustered hypervisor with a REST API; you build the product API and ingress | v7.6.0 (2026-10-30) · 1,999 | Solid substrate |
| **Proxmox VE** ([docs](https://pve.proxmox.com/pve-docs/chapter-pve-intro.html)) | AGPL-3.0 | KVM/QEMU and LXC | Yes | `qm suspend --todisk`, `qm snapshot --vmstate` ([qm(1)](https://pve.proxmox.com/pve-docs/qm.1.html)) | Same as Incus | not checked (not on GitHub) | Substrate |
| *(commercial)* **Boxd self-host** ([boxd.sh/pricing](https://boxd.sh/pricing)) | Annual licence; price not published. Not open source | KVM microVM | Yes | Hibernate writes memory to disk | "a single Rust binary … No Kubernetes, no external Postgres, no Redis" | n/a | Ask for a quote if buying rather than building |

**Building blocks**

| Component | License | Release · 90d commits | Key facts |
|---|---|---|---|
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | Apache-2.0 | v1.17.0 (2026-09-10) · 390 | VMM overhead "`<= 5 MiB`" and "`<= 125 ms`" to guest init for 1 vCPU / 128 MiB ([SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)). "Diff snapshots are still in developer preview"; "Guest network connectivity is not guaranteed to be preserved after resume" ([snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)). Jailer recommended for production |
| [firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd) | Apache-2.0 | no releases ever; last commit 2026-07-16 · 0 | Not a base to build on |
| [Cloud Hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) | Apache-2.0 + BSD-3-Clause | v54.0 (2026-10-14) · 966 | Host kernel ≥6.8. Snapshot/restore includes guest RAM, with on-demand restore via userfaultfd ([snapshot_restore.md](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md)). Live migration |
| [Kata Containers](https://github.com/kata-containers/kata-containers) | Apache-2.0 | 4.3.1 (2026-10-21) · 997 | Needs VT-x/SVM. Hypervisors: Cloud Hypervisor, Firecracker, QEMU, Dragonball, StratoVirt ([hypervisors.md](https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md)) |
| [gVisor](https://gvisor.dev/docs/architecture_guide/platforms/) | Apache-2.0 | release-20261026.0 · 1,777 | "systrap replaced ptrace as the default"; KVM platform optional. `runsc checkpoint/restore` is via raw `runsc`; connected sockets get `ECONNRESET` after restore ([checkpoint_restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)) |

### 4.2 What running E2B on Hetzner would take (from the repo)

**What changed in 2026**

- `e2b-dev/infra` now resolves to `e2b-dev/runtime` (Apache-2.0, not archived).
- Commit [`8a1c488`](https://github.com/e2b-dev/runtime/commit/8a1c48884406b909f64c1239c808d0bc1cbf05bf)
  (2026-09-10, "retire Nomad-based deployment ahead of a new deploy path",
  173 files) deleted `iac/provider-gcp`, `iac/provider-aws`, the Packer image
  and `self-host.md`.
- That old guide covered only GCP and AWS. It needed Terraform, Packer,
  Nomad/Consul, Postgres, buckets for templates and kernels, and Secrets Manager
  ([self-host.md @ 1875237](https://github.com/e2b-dev/runtime/blob/1875237447427cd44ab58877dcced8380bbc0840/self-host.md)).
  There was never a bare-metal or Hetzner provider.

**What exists today** is [Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md):
"Embed is one machine, by design. When you need more, E2B runs three other
ways". Those are a private cloud ("in development"), BYOC and E2B Cloud.

**Host requirements**
([preflight.sh](https://github.com/e2b-dev/runtime/blob/main/embed/compose/scripts/preflight.sh),
[compose README](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)):

- x86_64 kernel ≥6.8, `/dev/kvm`, `/dev/net/tun`, cgroup v2, the `nbd` module,
  Docker ≥27;
- "12 GiB RAM recommended and 20 GiB free disk".

Ubuntu 24.04 is recommended. Whether Hetzner's installimage kernel ships `nbd`
was not checked.

**Per-node caps** (compose README):

- "`NBDS_MAX` (default 64) … is the ceiling on concurrent sandboxes".
- "The orchestrator also refuses the 201st running sandbox … a limit this
  stack cannot raise."
- `HUGEPAGES=2048` reserves 4 GiB by default and must be sized to the fleet.
- Pausing needs free disk equal to the sandbox's memory.

An AX102-1 holds about 28 Profile A sandboxes at 1x RAM, so these caps do not
bind there. On an AX162-3 they would.

**What you'd build on top**

- **TLS and wildcard ingress.** Embed serves plain HTTP and routes ports by
  header (`E2b-Sandbox-Id` / `E2b-Sandbox-Port`) on :3002. Port 5008 is an
  "unauthenticated gRPC control API" that must be firewalled
  ([REFERENCE.md](https://github.com/e2b-dev/runtime/blob/main/embed/docs/REFERENCE.md)).
- **Multi-tenant auth.** Embed ships one team API key.
- **Placement across nodes.** The API code can discover nodes via
  "Kubernetes, DNS, a static list, or the legacy Nomad backend"
  ([ARCHITECTURE.md](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)),
  but nothing documents that setup.
- **Longer session limits.** Raise the per-team `max_length_hours`, which a
  migration sets to 1 h for the base tier
  ([migration](https://github.com/e2b-dev/runtime/blob/main/packages/db/migrations/20240219190940_add_max_length_hours.sql)).
- **Backups** of `/var/lib/e2b/storage`.

**What you get for free:** the SDK can target your domain through `E2B_DOMAIN`
([connectionConfig.ts](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/connectionConfig.ts)).

### 4.3 Sources for Part 1

| Claim | Source |
|---|---|
| E2B Runtime isolation, pause and auto-pause | https://github.com/e2b-dev/runtime/blob/main/README.md |
| E2B Embed scope, caps, requirements | https://github.com/e2b-dev/runtime/blob/main/embed/README.md, https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md |
| E2B multi-node removal | https://github.com/e2b-dev/runtime/commit/8a1c48884406b909f64c1239c808d0bc1cbf05bf |
| Daytona archived; AGPL; Sysbox | https://github.com/daytonaio/daytona/blob/main/README.md, https://github.com/daytonaio/daytona/blob/v0.190.0/LICENSE, https://github.com/daytonaio/daytona/blob/v0.190.0/docker/README.md |
| Daytona Helm charts Elastic-2.0 | https://github.com/daytonaio/helm-charts/blob/main/README.md |
| Cua licences; Cloud ended | https://github.com/trycua/cua/blob/main/README.md, https://github.com/trycua/cua/blob/main/docs/content/docs/cua-sdk/guides/cua-cloud-ended.mdx |
| Cua local runtimes; Hetzner Cloud has no KVM | https://github.com/trycua/cua/blob/main/docs/content/docs/cua-sdk/guides/local-runtimes.mdx, https://github.com/trycua/cua/blob/main/docs/content/docs/cua-sdk/guides/your-cloud.mdx |
| Microsandbox | https://github.com/superradcompany/microsandbox/blob/main/README.md, https://github.com/superradcompany/microsandbox/blob/main/docs/sandboxes/lifecycle.mdx |
| OpenSandbox | https://github.com/opensandbox-group/OpenSandbox/blob/main/README.md, https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/performance.md |
| agent-sandbox | https://github.com/kubernetes-sigs/agent-sandbox/blob/main/docs/api.md, https://github.com/kubernetes-sigs/agent-sandbox/blob/main/roadmap.md |
| Arrakis | https://github.com/abshkbh/arrakis/blob/main/README.md |
| Coder | https://github.com/coder/coder/blob/main/LICENSE.enterprise, https://github.com/coder/coder/blob/main/docs/admin/networking/wildcard-access-url.md, https://github.com/coder/coder/blob/main/docs/user-guides/workspace-lifecycle.md |
| Incus stateful stop | https://github.com/lxc/incus/blob/main/doc/howto/instances_backup.md |
| Hetzner Cloud: no nested virtualisation | https://docs.hetzner.com/cloud/servers/faq/ |
| Hetzner dedicated: AMD-V / Intel-VT | https://www.hetzner.com/dedicated-rootserver/matrix-ax/, https://www.hetzner.com/dedicated-rootserver/matrix-ex/ |

## 5. Part 2: Hetzner dedicated pricing

### 5.1 Current line-up

All prices exclude VAT and exclude the Primary IPv4, which costs €1.70 / $1.90
a month. Sources:

- **Prices**: Hetzner's website price API
  (`https://website-price-api.hetzner.com/api/v1/products/ROBOT_<id>`) and
  [live_data_prices.json](https://www.hetzner.com/_resources/app/data/app/live_data_prices.json).
  These match the
  [15 June 2026 price table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/).
- **RAM, ECC, disks and locations**: the configurator's product files, e.g.
  [AX102_en.json](https://www.hetzner.com/_resources/app/data/product/AX102_en.json)
  and the same pattern for the others.
- **Core and thread counts**:
  - AMD:
    [7950X3D](https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-9-7950x3d.html),
    [EPYC 9454P](https://www.amd.com/en/products/processors/server/epyc/4th-generation-9004-and-8004-series/amd-epyc-9454p.html),
    [Ryzen 5 3600](https://www.amd.com/en/support/downloads/drivers.html/processors/ryzen/ryzen-3000-series/amd-ryzen-5-3600.html).
  - Intel:
    [Xeon 6731P](https://www.intel.com/content/www/us/en/products/sku/242635/intel-xeon-6731p-processor-144m-cache-2-50-ghz/specifications.html),
    [Core Ultra 7 265](https://www.intel.com/content/www/us/en/products/sku/241068/intel-core-ultra-7-processor-265-30m-cache-up-to-5-30-ghz/specifications.html).
  - AX42 and EX44 thread counts are derived from Hetzner's own text ("Octa-Core
    … Simultaneous Multithreading"; "6-Performance-Cores + 8-Efficient-Cores
    … Hyper-Threading"). The vendor pages could not be fetched.
- **Locations**: each model is configurable in FSN1 (Falkenstein) and HEL1
  (Helsinki). The price API also returns NBG1 prices.
- **Billing**: hourly with a monthly cap and no minimum term: "We bill by the
  hour and never exceed the monthly price cap"; "You can only cancel
  immediately"
  ([Robot cancellations](https://docs.hetzner.com/general/billing-and-account-management/cancellation/cancellations-robot/)).

| Model | CPU (cores/threads) | RAM | NVMe | €/mo | $/mo | Setup € / $ | €/h | Limited ("-LTD") €/mo · setup |
|---|---|---|---|---|---|---|---|---|
| AX41-1 | Ryzen 5 3600 (6/12) | 64 GB DDR4, no ECC | 2x512 GB | 57.30 | 67.10 | 0 / 0 | 0.0918 | sold only as limited |
| AX42-1 | Ryzen 7 PRO 8700GE (8/16) | 64 GB DDR5, no ECC | 2x512 GB | 97.30 | 117.10 | 49 / 59 | 0.1559 | 77.30 · 39 |
| AX42-2 | same | 64 GB DDR5 ECC | 2x512 GB | 187.30 | 217.10 | 94 / 109 | 0.3002 | 122.30 · 39 |
| **AX102-1** | Ryzen 9 7950X3D (16/32) | 128 GB DDR5, **no ECC** | 2x1.92 TB DC | **257.30** | **302.10** | 129 / 149 | 0.4123 | **157.30 · 39** |
| AX102-3 | same | 128 GB DDR5 ECC | 2x1.92 TB DC | 452.30 | 532.10 | 224 / 264 | 0.7248 | 277.30 · 39 |
| AX102-2 | same | 192 GB DDR5 ECC | 2x1.92 TB DC | 547.30 | 642.10 | 274 / 319 | 0.8771 | — |
| AX102-4 | same | 128 GB DDR5 ECC | 2x1.92 + 2x7.68 TB | 757.30 | 892.10 | 379 / 449 | 1.2136 | — |
| AX162-1 | EPYC 9454P (48/96) | 128 GB DDR5 ECC reg. | 2x3.84 TB DC | 612.30 | 722.10 | 304 / 359 | 0.9813 | 317.30 · 39 |
| **AX162-2** | same | 256 GB DDR5 ECC reg. | 2x1.92 TB DC | 842.30 | 992.10 | 419 / 494 | 1.3498 | **317.30 · 39** |
| AX162-3 | same | 512 GB DDR5 ECC reg. | 4x3.84 TB DC | 1,597.30 | 1,897.10 | 799 / 949 | 2.5598 | — |
| AX162-4 | same | 256 GB DDR5 ECC reg. | 2x1.92 + 2x15.36 TB | 1,097.30 | 1,297.10 | 549 / 649 | 1.7585 | — |
| EX44-1 | i5-13500 (14/20) | 64 GB DDR4, no ECC | 2x512 GB | 57.30 | 72.10 | 0 / 0 | 0.0918 | sold only as limited |
| EX63-1 | Core Ultra 7 265 (20/20) | 64 GB DDR5, no ECC | 2x1 TB | 147.30 | 172.10 | 74 / 84 | 0.2361 | 97.30 · 39 |
| EX63-4 | same | 64 GB DDR5 ECC | 2x1 TB | 237.30 | 282.10 | 119 / 139 | 0.3803 | — |
| EX63-2 | same | 192 GB DDR5 ECC | 2x1.92 TB DC | 537.30 | 632.10 | 269 / 314 | 0.8611 | — |
| EX63-3 | same | 192 GB DDR5 ECC | 4x3.84 TB DC | 757.30 | 892.10 | 379 / 444 | 1.2136 | — |
| EX131-1 | Xeon 6731P (32/64) | 128 GB DDR5 ECC reg. | 2x1.92 TB DC | 557.30 | 667.10 | 279 / 334 | 0.8931 | 267.30 · 39 |
| EX131-2 | same | 256 GB DDR5 ECC reg. | 4x3.84 TB DC | 1,077.30 | 1,297.10 | 539 / 649 | 1.7264 | 512.30 · 49 |
| EX131-3 | same | 256 GB DDR5 ECC reg. | 4x7.68 TB DC | 1,397.30 | 1,597.10 | 699 / 799 | 2.2393 | — |

**ARM / RX line:** "Unfortunately, we are currently unable to offer any RX
servers" ([matrix-rx](https://www.hetzner.com/dedicated-rootserver/matrix-rx/)).
There is no AX52 any more: its old URL returns the dedicated-server overview page.

**Limited ("-LTD") tier:** "We will only offer the limited pricing tier once
servers with a significantly reduced procurement cost are available … offered
as long as supply lasts" (price adjustment page). The price API returns these
products as active, but this note could not confirm actual stock: the
availability endpoint returned 404. **On 2026-11-01 the shop did not offer
them.** No LTD product ID was in the shop's live price feed, and the AX162
configurator showed only AX162-1/-2/-3/-4 (§2.7).

**No RAM or drive add-ons on current types.** "You cannot order additional
hardware; instead, you must upgrade to a different server model"
([ax-server](https://docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/),
[ex-server](https://docs.hetzner.com/robot/dedicated-server/server-lines/ex-server/)).
Server Auction boxes can take add-ons after delivery (§2.7).

### 5.2 Price changes announced in 2025–2026

| Date | Change | Source |
|---|---|---|
| 2026-02-02 | Setup fees for dedicated servers raised: "The RAM market is currently dominated by very few manufacturers…"; monthly increases flagged as likely | [statement-setup-fees-adjustment](https://www.hetzner.com/pressroom/statement-setup-fees-adjustment/) |
| 2026-02-23 | Price increase from 2026-04-01 "for both new orders and existing products" | [statement-price-adjustment](https://www.hetzner.com/pressroom/statement-price-adjustment/) |
| 2026-04-29 | Setup fees raised again "as RAM and NVMe SSDs have continued to rise" | [statement on the latest adjustment to setup fees](https://www.hetzner.com/pressroom/statement-on%20the-latest-adjustment-to%20setup-fees/) |
| 2026-06-15 | Standardised `-1/-2/-3` types and new `-1-LTD` tier. Monthly prices raised for new orders; setup fees "significant[ly] reduc[ed]"; existing contracts unchanged. Cloud plans re-priced (e.g. CPX22 €7.99 → €19.49 a month excluding IPv4). Auction, IPs and storage products not affected | [press release](https://www.hetzner.com/pressroom/standardization-and-price-adjustment-of-our-server-products/), [price table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) |
| 2025 | No price adjustment found. The pressroom archive is JS-rendered; a site search found only product news | — |

**Currency and VAT:** prices exist in EUR and USD; all exclude VAT; the German
price list includes 19% VAT (§2.2).

### 5.3 Traffic, IPv4, add-ons

| Item | Fact | Source |
|---|---|---|
| Traffic | "All root servers have a dedicated 1 GBit uplink by default and with it unlimited traffic." The 10 Gbit uplink includes 20 TB, then €1 ($1.20)/TB. Only outgoing traffic counts | [docs: traffic](https://docs.hetzner.com/robot/general/traffic/) |
| 10G uplink add-on | €43.00 / $48.00 a month | price API product `ROBOT_1338` |
| Primary IPv4 | €1.70 / $1.90 a month, no setup fee | [IP pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/) |
| Additional IPv4 / Failover IP / /29 subnet | €1.70 + €4.90 setup / €4.20 + €4.90 / €13.60 + €34.90 | same |
| vSwitch (private VLAN between dedicated servers) | Private IPs free; "Internal traffic (across locations) is free of charge"; public subnets on a vSwitch include 1 TB, then €1/TB. Limits: 100 servers per vSwitch, 5 vSwitches per server; MTU 1400. No fee is listed for the vSwitch itself | [docs: vSwitch](https://docs.hetzner.com/robot/dedicated-server/network/vswitch/) |
| Storage Box (snapshot backups) | BX11 1 TB €3.20, BX21 5 TB €10.90, BX31 10 TB €20.80, BX41 20 TB €40.60 a month. 10/20/30/40 snapshots; unlimited traffic; 10 concurrent connections | [storage-box](https://www.hetzner.com/storage/storage-box/) |
| ECC | No ECC on AX41-1, AX42-1, AX102-1, EX44-1 and EX63-1; ECC on AX42-2, AX102-2/3/4 and EX63-2/3/4; ECC registered on all AX162 and EX131 | product JSON (`IsECC`, `ECCType`) |
| RAM / drive add-ons | **Not orderable for current AX/EX types.** For auction and legacy models, a support request after delivery. DDR4 Reg. ECC $22 per 32 GB or $39 per 64 GB; DDR5 Reg. ECC $81 / $131 / $225 per 32 / 64 / 96 GB; NVMe DC 0.96 / 1.92 / 3.84 / 7.68 / 15.36 TB at $45 / $83 / $114 / $201 / $378 a month | [add-on price list](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/) (2026-10-07), [ax-server](https://docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/) |

### 5.4 Server Auction

- **How the auction works:** "a Dutch-style auction … The prices start high,
  and go down over time". There are no setup fees, and cancellation is
  "usually immediately"
  ([Auction FAQ](https://docs.hetzner.com/robot/general/server-auction-faqs/)).
- **The listing on 2026-10-30.** The live feed
  ([live_data_sb.json](https://www.hetzner.com/_resources/app/data/app/live_data_sb.json))
  listed **72 servers**:
  - from **€72 to €944 a month**, plus €1.70 IPv4 (lowest offer €73.70 with IPv4);
  - **≥128 GB with NVMe**: i7-8700 128 GB 2x1 TB at €118–120, i9-9900K
    128 GB at €145–149, Ryzen 9 5950X 128 GB ECC 2x3.84 TB at €334–338, and
    Ryzen 7 7700 192 GB ECC at €351.
- **Prices hold up only for the oldest CPUs.** Per GiB of RAM, the i7-8700 at
  €118 for 128 GB beats a new AX102-1 at €257.30. But 6 cores / 12 threads
  for 128 GB makes it CPU-bound for sandboxes (B2), it has no ECC, and stock is
  3 units.
- **Thread counts** come from vendor pages:
  [i7-8700](https://www.intel.com/content/www/us/en/products/sku/126686/intel-core-i78700-processor-12m-cache-up-to-4-60-ghz/specifications.html) 6/12,
  [i9-9900K](https://www.intel.com/content/www/us/en/products/sku/186605/intel-core-i99900k-processor-16m-cache-up-to-5-00-ghz/specifications.html) 8/16,
  [5950X](https://www.amd.com/en/products/processors/desktops/ryzen/5000-series/amd-ryzen-9-5950x.html) 16/32,
  [7700](https://www.amd.com/en/products/processors/desktops/ryzen/7000-series/amd-ryzen-7-7700.html) 8/16.

### 5.5 Hetzner Cloud, for reference (today's per-workspace VM shape)

TerminalX's Hetzner provider creates Cloud VMs. Prices are from
[cloud/regular-performance](https://www.hetzner.com/cloud/regular-performance/)
and [cloud/cost-optimized](https://www.hetzner.com/cloud/cost-optimized/),
including IPv4 and excluding VAT:

- **CPX22** (2 vCPU, 4 GB, 80 GB) is €0.0320/h, capped at €19.99/month.
- **CPX32** (4 vCPU, 8 GB, 160 GB) is €0.0577/h, capped at €35.99/month.
- The cheaper **CX23** and **CX33** were marked "not available".

| plan | EUR/h | USD/h (ECB) | EUR monthly cap | USD monthly cap (ECB) |
|---|---|---|---|---|
| CPX22 (2 vCPU AMD, 4 GB, 80 GB) | €0.0320 | $0.0358 | €19.99 | $22.33 |
| CPX32 (4 vCPU AMD, 8 GB, 160 GB) | €0.0577 | $0.0645 | €35.99 | $40.21 |
| CX23 (2 vCPU, 4 GB, 40 GB; 'not available') | €0.0096 | $0.0107 | €5.99 | $6.69 |
| CX33 (4 vCPU, 8 GB, 80 GB; 'not available') | €0.0144 | $0.0161 | €8.99 | $10.04 |

## 6. Part 3: managed sandbox providers

### 6.1 Which product each name means

| Name in the brief | Product chosen | Why |
|---|---|---|
| Boat / boat.dev | **Boat**, [boat.dev](https://boat.dev) / [docs.boat.dev](https://docs.boat.dev/llms.txt) | It is the provider TerminalX integrates (`box` shown as "Boat"). "full root Ubuntu machines with SSH, Docker, a public IPv4 and a desktop" |
| Boxd | **boxd**, [boxd.sh](https://boxd.sh/pricing) | "Real hardware-isolated Linux VMs in the cloud"; "Every boxd machine is a KVM microVM" ([llms.txt](https://boxd.sh/llms.txt)) |
| instabox | **InstaBox**, [instabox.sh](https://instabox.sh/docs/pricing.md) | It is the only agent-sandbox product with that name: "InstaBox gives each agent a Linux machine of its own in the cloud". Rejected: instabox.dev (sells email accounts), instabox.io/.com (parcel delivery), instabox.ai/.app/.run (do not resolve). [InstaVM](https://instavm.io/pricing) is a different product: Firecracker, $0.000014/vCPU-s and $0.0000045/GB-s, Pro $100/month base |
| day2na | **Daytona**, [daytona.io/pricing](https://www.daytona.io/pricing) | — |
| E2B | **E2B**, [e2b.dev/pricing](https://e2b.dev/pricing.md) | — |
| Cua | **Cua**, [cua.ai](https://cua.ai/pricing) | Cua Cloud ended on 2026-10-18 ([cua-cloud-ended](https://cua.ai/docs/cua-sdk/guides/cua-cloud-ended.md)). Current plans sell a relay, not compute |

### 6.2 Pricing and limits

| Provider | Compute price | Storage | Plan / fees | Free tier | Concurrency | Max session | Paused / stopped billing | Isolation | Regions |
|---|---|---|---|---|---|---|---|---|---|
| **Boat** | Fixed sizes: $0.018 / 0.036 / 0.072 / 0.200 per hour (§2.1), per second | Disk included in the size; saved snapshots beyond the included 10 cost $0.056/day | $20/$100/$500/$2,000 plans, returned as VM time; per seat for orgs | 7-day trial, card required, 25 h | 100 / 300 / 1,000 / 2,000 by plan | Auto-stop up to 30 days or off | Stopped: $0, disk kept 14 days; **no pause** (no memory) | Full VM per sandbox; hypervisor not named; shared vCPU | EU (DE, FI, FR), not selectable |
| **InstaBox** | $0.004 per vCPU-hour + $0.00225 per GiB-hour, per second while running | 20 GiB included; then $0.00011 per GiB-hour ("about $0.08 per GiB-month"), billed while the disk exists | Pro $20, Builder $100, Team $500 (fees returned as credits); Enterprise custom | Free: 1 machine, 4 vCPU / 8 GiB | Pro 100, Builder 200, Team 500 running | Free 480 min; paid unlimited | Paused: disk beyond 20 GiB only; "a paused sandbox's saved memory [is] free" | Firecracker microVM | not published |
| **Boxd** | €0.039 ($0.047) per vCPU-hour on size + €0.012 ($0.014) per GiB-hour of **resident** RAM | €0.00008 ($0.000096) per GiB-hour of **written** disk | none | €30 credits | 100 machines per org (pricing FAQ; docs say 50) | "Unlimited" | Standby: RAM + disk. Hibernated / stopped: written disk only. Hibernate wake: "About 85ms" (docs) vs "sub-millisecond" (pricing FAQ) | KVM microVM | "EU-hosted" |
| **E2B** | $0.000014 per vCPU-s ($0.0504/h) + $0.0000045 per GiB-s ($0.0162/h) | Free (10 GiB Hobby, 20 GiB Pro; more via support) | Pro $150/month fee (not credited); concurrency add-ons to $650 / $1,150 total | Hobby $100 one-time credit | Hobby 20; Pro 100 / 600 / 1,100 | Hobby 1 h; Pro 24 h continuous (pause/resume resets) | Paused: **free, memory kept**, no time limit | Firecracker | GCP us-west1 and others; EU and APAC on request |
| **Daytona** | $0.0504 per vCPU-hour + $0.0162 per GiB-hour, per second | $0.000108 per GiB-hour after 5 GiB free | none | $200 credits | Org pools: Tier 1 10 vCPU … Tier 4 500 vCPU / 1,000 GiB / 5,000 GiB | Auto-stop 15 min default; 0 = indefinite | Stopped / paused: reserved disk only; pause keeps memory **on VM sandboxes only**; archived: free | Containers by default; VM option (hypervisor not named) | us, eu |
| **Cua** | n/a, no hosted compute since 2026-10-18 | — | Relay plans $0 / $18 / $30 per seat | — | — | — | — | — | — |

**Notes on the table**

- **Daytona per-sandbox caps.** The default cap is 4 vCPU / 8 GB / 10 GB disk
  ([limits](https://www.daytona.io/docs/en/limits.md)), so Profiles A and B
  need a raised disk cap.
- **GPU.** Only Daytona lists GPUs, from RTX 4090 at $0.99/h to B300 at
  $6.25/h. E2B: "does not offer GPU sandboxes". Boat: "No size has a GPU".

**Sources**

| Provider | Pages |
|---|---|
| E2B | [pricing.md](https://e2b.dev/pricing.md), [persistence](https://docs.e2b.dev/sandbox/persistence.md), [paused-sandboxes-concurrency](https://docs.e2b.dev/faq/paused-sandboxes-concurrency.md), [billing](https://docs.e2b.dev/billing.md) |
| Daytona | [pricing](https://www.daytona.io/pricing), [billing.md](https://www.daytona.io/docs/en/billing.md), [limits.md](https://www.daytona.io/docs/en/limits.md), [isolation.md](https://www.daytona.io/docs/en/isolation.md) |
| Boxd | [pricing](https://boxd.sh/pricing) (USD rate card in the page's FAQ data), [llms.txt](https://boxd.sh/llms.txt) |
| InstaBox | [pricing.md](https://instabox.sh/docs/pricing.md), [billing.md](https://instabox.sh/docs/billing.md), [limits.md](https://instabox.sh/docs/limits.md) |

## 7. Part 4: the economic model

### 7.1 Assumptions (all are parameters in `PARAMS`)

| Parameter | Value | Why / how to change |
|---|---|---|
| `host_reserve_fixed_gib` + `host_reserve_frac` | 4 GiB + 6% of RAM per host | Host OS, node agent, page cache, safety margin |
| `host_reserve_threads` | 2 per host | Host and VMM threads |
| `vmm_overhead_gib` | 0.10 GiB per sandbox | Firecracker states ≤5 MiB VMM overhead for a tiny VM; this adds page tables, virtio and tap headroom |
| `ram_overcommit` | 1.0 (B4: 1.25; B5: 2.0) | Brief: keep RAM near 1x. Boat's published median RAM use is 18.89% |
| CPU overcommit | 1x / 2x / 4x | Boat's published median CPU use is 8.79% |
| `disk_raid_usable_frac`, `disk_os_reserve_gib`, `disk_overcommit` | 0.5, 100 GiB, 1.0 (B4/B5: 2.0) | RAID1/RAID10, thick disks; thin CoW would raise it |
| `control_plane_ram_gib`, `control_plane_threads` | 16 GiB, 4 threads on one host | API, DB and scheduler on the fleet |
| Usage pattern U1 | 8 h × 5 days × 52 / 12 = **173.33 h/month** per seat, all seats at once | Brief's example. Always-on = 730 h |
| `stored_ratio` | 2 suspended workspaces per peak sandbox | Sizes the Storage Box backup: (disk + RAM) per stored workspace |
| `engineer_month_usd` | $15,000 fully loaded | Ops cases: 0, 0.5 and 1.0 FTE, covering build amortisation plus on-call |
| `setup_amortize_months` | 12 | Setup fees shown once and as /12 |
| Sandbox GiB vs vendor "GB" | Boat and Hetzner "GB" treated as GiB | Conservative for the self-host side |
| Pricing mode | USD list (headline) or EUR@ECB 1.1172 | §2.2 |

### 7.2 The arithmetic, worked once (AX102-1, Profile A)

- **RAM:**
  - available: 128 − (4 + 0.06 × 128) = 128 − 11.68 = **116.32 GiB**;
  - per sandbox: 4 + 0.1 = 4.1 GiB;
  - fit: ⌊116.32 / 4.1⌋ = **28**.
- **CPU:**
  - threads: 32 − 2 = 30;
  - fit at 1x: ⌊30 / 2⌋ = 15;
  - fit at 2x: ⌊60 / 2⌋ = 30.
- **Disk:**
  - raw: 2 × 1.92 TB = 3.84 × 10¹² B = 3,576 GiB;
  - usable: ×0.5 − 100 = 1,688 GiB;
  - fit: ⌊1,688 / 20⌋ = 84 for Profile A, or ⌊1,688 / 51⌋ = 33 for Boat `small`.
- **Binding limit:** min = 15 at 1x (CPU) and **28 at 2x or 4x (RAM)**.
- **Cost per slot:**
  - price: $302.10 + $1.90 IPv4 = **$304.00/month**;
  - per slot: $304 / 28 = **$10.86 per slot-month**;
  - per hour at 100%: $10.86 / 730 = **$0.0149/h**;
  - per hour at U1 (173.33 / 730 = 23.7%): $10.86 / 173.33 = **$0.0626/h**.
- **Utilisation that matches Boat `small`:** $10.86 / ($0.018 × 730) = **83%**.
- **Fleet for N peak with N+1:** k = 2 + ⌈(N − cap_with_control_plane) / cap⌉ servers.
  - With the control plane, a host has 116.32 − 16 = 100.32 GiB, giving 24 sandboxes.
  - N = 200 gives 2 + ⌈176 / 28⌉ = 9 servers.
  - 9 × $304 + Storage Box $45.36 + setup $1,341 / 12 = **$2,893.11/month**.
- **Managed seat-month:** run rate × hours + idle rate × (730 − hours) + plan
  rules.
  - Boat and InstaBox plans are floors, because the plan money is credited
    back as usage. E2B's fee is added on top.
  - Example: E2B Profile A at U1 is (2 × 0.0504 + 4 × 0.0162) × 173.33 =
    **$28.70** per seat, plus $150 per month.

### 7.3 Sandboxes per server (calculator output T1)

| server | threads | RAM GiB | NVMe raw | ECC | month incl. IPv4 (EUR / USD list) | A 1x | A 2x | A 4x | B 1x | B 2x | B 4x |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AX41-1 | 12 | 64 | 1.02 TB | no | €59.00 / $69.00 | 5 CPU | 10 CPU | 13 RAM | 2 CPU | 5 CPU | 6 RAM |
| AX42-1 | 16 | 64 | 1.02 TB | no | €99.00 / $119.00 | 7 CPU | 13 RAM | 13 RAM | 3 CPU | 6 RAM | 6 RAM |
| AX102-1 | 32 | 128 | 3.84 TB | no | €259.00 / $304.00 | 15 CPU | 28 RAM | 28 RAM | 7 CPU | 14 RAM | 14 RAM |
| AX102-3 | 32 | 128 | 3.84 TB | ECC | €454.00 / $534.00 | 15 CPU | 28 RAM | 28 RAM | 7 CPU | 14 RAM | 14 RAM |
| AX102-2 | 32 | 192 | 3.84 TB | ECC | €549.00 / $644.00 | 15 CPU | 30 CPU | 43 RAM | 7 CPU | 15 CPU | 21 RAM |
| AX162-1 | 96 | 128 | 7.68 TB | ECC reg | €614.00 / $724.00 | 28 RAM | 28 RAM | 28 RAM | 14 RAM | 14 RAM | 14 RAM |
| AX162-2 | 96 | 256 | 3.84 TB | ECC reg | €844.00 / $994.00 | 47 CPU | 57 RAM | 57 RAM | 23 CPU | 29 RAM | 29 RAM |
| AX162-3 | 96 | 512 | 15.36 TB | ECC reg | €1599.00 / $1899.00 | 47 CPU | 94 CPU | 116 RAM | 23 CPU | 47 CPU | 58 RAM |
| EX44-1 | 20 | 64 | 1.02 TB | no | €59.00 / $74.00 | 9 CPU | 13 RAM | 13 RAM | 4 CPU | 6 RAM | 6 RAM |
| EX63-1 | 20 | 64 | 2.00 TB | no | €149.00 / $174.00 | 9 CPU | 13 RAM | 13 RAM | 4 CPU | 6 RAM | 6 RAM |
| EX63-2 | 20 | 192 | 3.84 TB | ECC | €539.00 / $634.00 | 9 CPU | 18 CPU | 36 CPU | 4 CPU | 9 CPU | 18 CPU |
| EX131-1 | 64 | 128 | 3.84 TB | ECC reg | €559.00 / $669.00 | 28 RAM | 28 RAM | 28 RAM | 14 RAM | 14 RAM | 14 RAM |
| EX131-2 | 64 | 256 | 15.36 TB | ECC reg | €1079.00 / $1299.00 | 31 CPU | 57 RAM | 57 RAM | 15 CPU | 29 RAM | 29 RAM |
| AX102-1-LTD | 32 | 128 | 3.84 TB | no | €159.00 / $189.00 | 15 CPU | 28 RAM | 28 RAM | 7 CPU | 14 RAM | 14 RAM |
| AX102-3-LTD | 32 | 128 | 3.84 TB | ECC | €279.00 / $334.00 | 15 CPU | 28 RAM | 28 RAM | 7 CPU | 14 RAM | 14 RAM |
| AX162-1-LTD | 96 | 128 | 7.68 TB | ECC reg | €319.00 / $374.00 | 28 RAM | 28 RAM | 28 RAM | 14 RAM | 14 RAM | 14 RAM |
| AX162-2-LTD | 96 | 256 | 3.84 TB | ECC reg | €319.00 / $374.00 | 47 CPU | 57 RAM | 57 RAM | 23 CPU | 29 RAM | 29 RAM |
| EX131-1-LTD | 64 | 128 | 3.84 TB | ECC reg | €269.00 / $314.00 | 28 RAM | 28 RAM | 28 RAM | 14 RAM | 14 RAM | 14 RAM |

### 7.4 Per-hour rates (T2), Hetzner per-hour at utilisation (T3) and matching utilisation (T7)

| profile | provider | shape billed | run $/h | idle $/h | seat-month U1 (173.3 h) | seat-month always-on |
|---|---|---|---|---|---|---|
| Profile A | Boat | Boat small | $0.0180 | $0.0000 | $3.12 | $13.14 |
| Profile A | InstaBox | Profile A | $0.0170 | $0.0000 | $2.95 | $12.41 |
| Profile A | Boxd | Profile A | $0.1519 | $0.0019 | $27.40 | $110.90 |
| Profile A | E2B | Profile A | $0.1656 | $0.0000 | $28.70 | $120.89 |
| Profile A | Daytona | Profile A | $0.1672 | $0.0016 | $29.89 | $122.07 |
| Profile B | Boat | Boat default | $0.0360 | $0.0000 | $6.24 | $26.28 |
| Profile B | InstaBox | Profile B | $0.0362 | $0.0022 | $7.50 | $26.43 |
| Profile B | Boxd | Profile B | $0.3038 | $0.0038 | $54.80 | $221.80 |
| Profile B | E2B | Profile B | $0.3312 | $0.0000 | $57.41 | $241.78 |
| Profile B | Daytona | Profile B | $0.3350 | $0.0038 | $60.17 | $244.54 |

| server | profile | per server | $/slot-month | u=100% | u=50% | u=23.7% (U1) |
|---|---|---|---|---|---|---|
| AX102-1 | Profile A | 28 (RAM) | $10.86 | $0.0149 | $0.0297 | $0.0626 |
| AX102-1 | Profile B | 14 (RAM) | $21.71 | $0.0297 | $0.0595 | $0.1253 |
| AX102-3 | Profile A | 28 (RAM) | $19.07 | $0.0261 | $0.0523 | $0.1100 |
| AX102-3 | Profile B | 14 (RAM) | $38.14 | $0.0523 | $0.1045 | $0.2201 |
| AX162-2 | Profile A | 57 (RAM) | $17.44 | $0.0239 | $0.0478 | $0.1006 |
| AX162-2 | Profile B | 29 (RAM) | $34.28 | $0.0470 | $0.0939 | $0.1977 |
| AX162-3 | Profile A | 94 (CPU) | $20.20 | $0.0277 | $0.0553 | $0.1166 |
| AX162-3 | Profile B | 47 (CPU) | $40.40 | $0.0553 | $0.1107 | $0.2331 |
| AX42-1 | Profile A | 13 (RAM) | $9.15 | $0.0125 | $0.0251 | $0.0528 |
| AX42-1 | Profile B | 6 (RAM) | $19.83 | $0.0272 | $0.0543 | $0.1144 |
| AX102-1-LTD | Profile A | 28 (RAM) | $6.75 | $0.0092 | $0.0185 | $0.0389 |
| AX102-1-LTD | Profile B | 14 (RAM) | $13.50 | $0.0185 | $0.0370 | $0.0779 |
| AX162-2-LTD | Profile A | 57 (RAM) | $6.56 | $0.0090 | $0.0180 | $0.0379 |
| AX162-2-LTD | Profile B | 29 (RAM) | $12.90 | $0.0177 | $0.0353 | $0.0744 |

| server | profile | CPU oc | per server | $/slot-month | Boat | InstaBox | Boxd | E2B | Daytona |
|---|---|---|---|---|---|---|---|---|---|
| AX102-1 | Profile A | 2x | 28 (RAM) | $10.86 | 83% | 87% | 10% | 9% | 9% |
| AX102-1 | Profile A | 4x | 28 (RAM) | $10.86 | 83% | 87% | 10% | 9% | 9% |
| AX102-1 | Profile B | 2x | 14 (RAM) | $21.71 | 83% | 82% | 10% | 9% | 9% |
| AX102-1 | Profile B | 4x | 14 (RAM) | $21.71 | 83% | 82% | 10% | 9% | 9% |
| AX102-3 | Profile A | 2x | 28 (RAM) | $19.07 | never (145%) | never (154%) | 17% | 16% | 16% |
| AX102-3 | Profile A | 4x | 28 (RAM) | $19.07 | never (145%) | never (154%) | 17% | 16% | 16% |
| AX102-3 | Profile B | 2x | 14 (RAM) | $38.14 | never (145%) | never (144%) | 17% | 16% | 16% |
| AX102-3 | Profile B | 4x | 14 (RAM) | $38.14 | never (145%) | never (144%) | 17% | 16% | 16% |
| AX162-2 | Profile A | 2x | 57 (RAM) | $17.44 | never (133%) | never (141%) | 16% | 14% | 14% |
| AX162-2 | Profile A | 4x | 57 (RAM) | $17.44 | never (133%) | never (141%) | 16% | 14% | 14% |
| AX162-2 | Profile B | 2x | 29 (RAM) | $34.28 | never (130%) | never (130%) | 15% | 14% | 14% |
| AX162-2 | Profile B | 4x | 29 (RAM) | $34.28 | never (130%) | never (130%) | 15% | 14% | 14% |
| AX42-1 | Profile A | 2x | 13 (RAM) | $9.15 | 70% | 74% | 8% | 8% | 7% |
| AX42-1 | Profile A | 4x | 13 (RAM) | $9.15 | 70% | 74% | 8% | 8% | 7% |
| AX42-1 | Profile B | 2x | 6 (RAM) | $19.83 | 75% | 75% | 9% | 8% | 8% |
| AX42-1 | Profile B | 4x | 6 (RAM) | $19.83 | 75% | 75% | 9% | 8% | 8% |
| AX102-1-LTD | Profile A | 2x | 28 (RAM) | $6.75 | 51% | 54% | 6% | 6% | 6% |
| AX102-1-LTD | Profile A | 4x | 28 (RAM) | $6.75 | 51% | 54% | 6% | 6% | 6% |
| AX102-1-LTD | Profile B | 2x | 14 (RAM) | $13.50 | 51% | 51% | 6% | 6% | 6% |
| AX102-1-LTD | Profile B | 4x | 14 (RAM) | $13.50 | 51% | 51% | 6% | 6% | 6% |
| AX162-2-LTD | Profile A | 2x | 57 (RAM) | $6.56 | 50% | 53% | 6% | 5% | 5% |
| AX162-2-LTD | Profile A | 4x | 57 (RAM) | $6.56 | 50% | 53% | 6% | 5% | 5% |
| AX162-2-LTD | Profile B | 2x | 29 (RAM) | $12.90 | 49% | 49% | 6% | 5% | 5% |
| AX162-2-LTD | Profile B | 4x | 29 (RAM) | $12.90 | 49% | 49% | 6% | 5% | 5% |

### 7.5 Scenarios: 10 / 50 / 200 / 1,000 peak concurrent sandboxes

**AX102-1 fleet** (USD list, 2x CPU, N+1, Storage Box for 2x stored
workspaces):

| profile | peak N | servers (N+1) | servers/mo | storage box/mo | setup once | hw total/mo (setup /12) | +0.5 FTE | +1.0 FTE | $/sandbox-h U1 (hw) | $/sandbox-h always-on (hw) | $/sandbox-h U1 (+0.5 FTE) | $/sandbox-h always-on (+0.5 FTE) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Profile A | 10 | 2 | $608.00 | $3.58 | $298.00 | $636.41 | $8,136.41 | $15,636.41 | $0.3672 | $0.0872 | $4.6941 | $1.1146 |
| Profile A | 50 | 3 | $912.00 | $12.18 | $447.00 | $961.43 | $8,461.43 | $15,961.43 | $0.1109 | $0.0263 | $0.9763 | $0.2318 |
| Profile A | 200 | 9 | $2,736.00 | $45.36 | $1,341.00 | $2,893.11 | $10,393.11 | $17,893.11 | $0.0835 | $0.0198 | $0.2998 | $0.0712 |
| Profile A | 1000 | 37 | $11,248.00 | $181.43 | $5,513.00 | $11,888.85 | $19,388.85 | $26,888.85 | $0.0686 | $0.0163 | $0.1119 | $0.0266 |
| Profile B | 10 | 2 | $608.00 | $12.18 | $298.00 | $645.01 | $8,145.01 | $15,645.01 | $0.3721 | $0.0884 | $4.6990 | $1.1158 |
| Profile B | 50 | 5 | $1,520.00 | $23.24 | $745.00 | $1,605.32 | $9,105.32 | $16,605.32 | $0.1852 | $0.0440 | $1.0506 | $0.2495 |
| Profile B | 200 | 16 | $4,864.00 | $90.72 | $2,384.00 | $5,153.38 | $12,653.38 | $20,153.38 | $0.1487 | $0.0353 | $0.3650 | $0.0867 |
| Profile B | 1000 | 73 | $22,192.00 | $362.87 | $10,877.00 | $23,461.28 | $30,961.28 | $38,461.28 | $0.1354 | $0.0321 | $0.1786 | $0.0424 |

**Managed providers at the same peak N:**

| profile | peak N | pattern | Boat | InstaBox | Boxd | E2B | Daytona |
|---|---|---|---|---|---|---|---|
| Profile A | 10 | U1 | $31.20 | $29.47 | $274.02 | $437.04 | $298.87 |
| Profile A | 10 | always-on | $131.40 | $124.10 | $1,109.02 | $1,358.88 | $1,220.71 |
| Profile A | 50 | U1 | $156.00 | $147.33 | $1,370.08 | $1,585.20 | $1,494.33 |
| Profile A | 50 | always-on | $657.00 | $620.50 | $5,545.08 | $6,194.40 | $6,103.53 |
| Profile A | 200 | U1 | $624.00 | $589.33 | $5,480.32 | $6,390.80 | $5,977.32 |
| Profile A | 200 | always-on | $2,628.00 | $2,482.00 | $22,180.32 | $24,827.60 | $24,414.12 |
| Profile A | 1000 | U1 | $3,120.00 | n/a | $27,401.60 | $29,854.00 | $29,886.60 |
| Profile A | 1000 | always-on | $13,140.00 | n/a | $110,901.60 | $122,038.00 | $122,070.60 |
| Profile B | 10 | U1 | $62.40 | $74.99 | $548.03 | $724.08 | $601.67 |
| Profile B | 10 | always-on | $262.80 | $264.26 | $2,218.03 | $2,567.76 | $2,445.35 |
| Profile B | 50 | U1 | $312.00 | $374.97 | $2,740.16 | $3,020.40 | $3,008.37 |
| Profile B | 50 | always-on | $1,314.00 | $1,321.30 | $11,090.16 | $12,238.80 | $12,226.77 |
| Profile B | 200 | U1 | $1,248.00 | $1,499.87 | $10,960.64 | $12,131.60 | $12,033.48 |
| Profile B | 200 | always-on | $5,256.00 | $5,285.20 | $44,360.64 | $49,005.20 | $48,907.08 |
| Profile B | 1000 | U1 | $6,240.00 | n/a | $54,803.20 | $58,558.00 | $60,167.40 |
| Profile B | 1000 | always-on | $26,280.00 | n/a | $221,803.20 | $242,926.00 | $244,535.40 |

**AX162-2-LTD fleet** (only while Hetzner has limited stock):

| profile | peak N | servers (N+1) | servers/mo | storage box/mo | setup once | hw total/mo (setup /12) | +0.5 FTE | +1.0 FTE | $/sandbox-h U1 (hw) | $/sandbox-h always-on (hw) | $/sandbox-h U1 (+0.5 FTE) | $/sandbox-h always-on (+0.5 FTE) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Profile A | 10 | 2 | $748.00 | $3.58 | $78.00 | $758.08 | $8,258.08 | $15,758.08 | $0.4374 | $0.1038 | $4.7643 | $1.1312 |
| Profile A | 50 | 2 | $748.00 | $12.18 | $78.00 | $766.68 | $8,266.68 | $15,766.68 | $0.0885 | $0.0210 | $0.9538 | $0.2265 |
| Profile A | 200 | 5 | $1,870.00 | $45.36 | $195.00 | $1,931.61 | $9,431.61 | $16,931.61 | $0.0557 | $0.0132 | $0.2721 | $0.0646 |
| Profile A | 1000 | 19 | $7,106.00 | $181.43 | $741.00 | $7,349.18 | $14,849.18 | $22,349.18 | $0.0424 | $0.0101 | $0.0857 | $0.0203 |
| Profile B | 10 | 2 | $748.00 | $12.18 | $78.00 | $766.68 | $8,266.68 | $15,766.68 | $0.4423 | $0.1050 | $4.7692 | $1.1324 |
| Profile B | 50 | 3 | $1,122.00 | $23.24 | $117.00 | $1,154.99 | $8,654.99 | $16,154.99 | $0.1333 | $0.0316 | $0.9987 | $0.2371 |
| Profile B | 200 | 8 | $2,992.00 | $90.72 | $312.00 | $3,108.72 | $10,608.72 | $18,108.72 | $0.0897 | $0.0213 | $0.3060 | $0.0727 |
| Profile B | 1000 | 36 | $13,464.00 | $362.87 | $1,404.00 | $13,943.87 | $21,443.87 | $28,943.87 | $0.0804 | $0.0191 | $0.1237 | $0.0294 |

### 7.6 Break-even

**AX102-1:**

| profile | pattern | ops | Boat | InstaBox | Boxd | E2B | Daytona |
|---|---|---|---|---|---|---|---|
| Profile A | U1 | hardware only | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 24 | 18 | 22 |
| Profile A | U1 | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 497 | 430 | 434 |
| Profile A | U1 | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 970 | 830 | 836 |
| Profile A | always-on | hardware only | 245 | 388 | 6 | 5 | 6 |
| Profile A | always-on | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 80 | 72 | 72 |
| Profile A | always-on | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 156 | 135 | 142 |
| Profile B | U1 | hardware only | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 12 | 9 | 11 |
| Profile B | U1 | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 249 | 215 | 216 |
| Profile B | U1 | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 485 | 430 | 415 |
| Profile B | always-on | hardware only | 123 | 110 | 3 | 3 | 3 |
| Profile B | always-on | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 40 | 36 | 36 |
| Profile B | always-on | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 78 | 71 | 71 |

**AX162-2-LTD:**

| profile | pattern | ops | Boat | InstaBox | Boxd | E2B | Daytona |
|---|---|---|---|---|---|---|---|
| Profile A | U1 | hardware only | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 28 | 22 | 26 |
| Profile A | U1 | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 387 | 334 | 355 |
| Profile A | U1 | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 759 | 659 | 671 |
| Profile A | always-on | hardware only | 88 | 94 | 7 | 6 | 7 |
| Profile A | always-on | lean ops (0.5 FTE) | 1249 | none up to 500 (self-serve limit) | 79 | 71 | 71 |
| Profile A | always-on | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 150 | 132 | 136 |
| Profile B | U1 | hardware only | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 14 | 11 | 13 |
| Profile B | U1 | lean ops (0.5 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 194 | 167 | 170 |
| Profile B | U1 | realistic ops (1.0 FTE) | none up to 2000 (self-serve limit) | none up to 500 (self-serve limit) | 373 | 338 | 334 |
| Profile B | always-on | hardware only | 44 | 44 | 4 | 3 | 4 |
| Profile B | always-on | lean ops (0.5 FTE) | 625 | none up to 500 (self-serve limit) | 40 | 36 | 36 |
| Profile B | always-on | realistic ops (1.0 FTE) | 1205 | none up to 500 (self-serve limit) | 75 | 68 | 68 |

**Reading:**

- **Boat and InstaBox.** Self-hosting is never cheaper under the U1 pattern,
  whatever the scale or ops cost. It wins always-on only on hardware alone, at
  ≥245 peak (AX102-1) or ≥88 (AX162-2-LTD). Any engineering cost pushes the
  break-even past Boat's 2,000 self-serve limit. The one exception is
  AX162-2-LTD with 0.5 FTE, at 1,249.
- **E2B, Daytona and Boxd.** With 0.5 FTE, self-hosting wins from about 70
  (always-on) or about 430 (U1) Profile A sandboxes. Profile B roughly halves
  these numbers.

## 8. What the money doesn't capture

- **Resume quality** (the biggest functional gap for TerminalX):
  - Boat: "There is no pause"; resume is a cold boot.
  - E2B: pause keeps memory and processes ("approximately 4 seconds per 1 GiB
    of RAM" to pause, about 1 s to resume).
  - InstaBox: pause keeps memory.
  - Boxd: hibernate keeps memory and wakes in "About 85ms" per the docs, or
    "sub-millisecond" per the pricing FAQ.
  - Daytona: memory pause only on VM sandboxes.
  - Self-hosted: Firecracker, Cloud Hypervisor, Incus VMs and E2B Embed can all
    preserve memory. OpenSandbox's measured resume is about 63 s.
  - A memory-preserving resume would let TerminalX keep terminals and agent
    processes alive across suspend; `preservesProcessesOnResume` is false for
    every cloud provider today.
- **Cold start:**
  - Firecracker documents ≤125 ms to guest init.
  - Boat's benchmark machine runs 27.7 build/test loops per second, against
    11.2 for E2B and 18.6 for Daytona (Boat's own benchmark,
    [pricing.md](https://docs.boat.dev/pricing.md)). That is a vendor claim.
- **Multi-region:**
  - Hetzner dedicated servers are only in Germany (FSN1, NBG1) and Finland
    (HEL1) per the price API. US users would see EU latency.
  - Boat is EU-only and does not let you choose.
  - E2B offers US, EU and APAC; Daytona offers us and eu.
- **Compliance:**
  - Hetzner offers a GDPR DPA and states ISO 27001:2022 for its Nuremberg,
    Falkenstein and Helsinki data centres
    ([matrix-ax](https://www.hetzner.com/dedicated-rootserver/matrix-ax/) footer).
  - Boat: "Snapshot copies can be stored outside the EU" (FAQ).
  - Self-hosting gives TerminalX the data boundary, and also the abuse,
    security-incident and customer-data obligations.
- **Build effort for TerminalX's API surface.** Everything the desktop calls on
  a provider today, it would call on its own platform:
  - create, stop, resume, delete, archive;
  - exec, PTY, files and clone at launch;
  - idle auto-suspend, quotas (`organizationCompute.ts`), usage metering and
    quotes (`ComputeProviderUsage`);
  - preview URLs: a wildcard DNS plus TLS proxy, which Coder has built in and
    E2B Embed does not;
  - image and template builds, desktop images (Cua's xfce/kasm images are MIT),
    monitoring, backups, kernel and hypervisor patching, and capacity ordering
    (dedicated servers carry setup fees and are not elastic).
- **Elasticity:**
  - Hetzner dedicated servers bill hourly up to the monthly cap. Bursting still
    pays a setup fee: €129 for AX102-1, or €39 for an LTD unit.
  - Boat and InstaBox scale per second up to their plan limits.

## 9. Risks and open questions

1. **The repo's Boat quote fixture disagrees with Boat's catalogue.** The test
   expects "Standard (4 vCPU, 8 GB) · Frankfurt" at $0.12/h and $3.00/month
   stopped; Boat publishes `default` at $0.036/h and $0 while stopped.
   - Check the terminalx-saas quote table for Boat, which is not in this repo.
     If production uses $0.12/h, it overstates Boat's cost 3.3x.
2. **Boat's price is at bare-metal cost.** Boat sells `small` for $13.14 per
   730 h; a list-price AX102-1 slot costs $10.86 before N+1 and engineering.
   Boat's margin presumably comes from overcommit and multi-tenant time
   multiplexing. Price rises are a real risk, and Hetzner itself raised prices
   three times in 2026. Keep a second provider integrated.
3. **InstaBox maturity.** Its pricing doc refers to accounts registered before
   2026-10-20, so the product is weeks old. It publishes no region and caps at
   500 running on self-serve.
4. **Hetzner price volatility and LTD stock.** The cheapest fleets (LTD) are
   explicitly "as long as supply lasts". This note could not confirm stock:
   the availability endpoint returned 404.
5. **Non-ECC RAM** on the cheapest servers (AX102-1, AX42-1). For long-lived
   customer workspaces, ECC (AX102-3, AX162) costs about 1.75x per slot at
   list price, but the same or less on LTD (AX162-2-LTD at $6.56 per slot vs
   AX102-1-LTD at $6.75).
6. **E2B Embed limits.** It is single node, capped at 200 running and 64 NBD
   devices by default, has an unauthenticated control port, and its multi-node
   path is unpublished ("a new deploy path").
7. **Licences.** AGPL (Coder, Proxmox) means offering a modified version as a
   service requires publishing the changes. Cua spacesd's FSL forbids a
   competing hosted service.
8. **Business model.** Today TerminalX customers pay their compute provider
   directly with their own key. Self-hosting makes TerminalX the reseller,
   with billing, abuse handling and capacity risk.
9. **Open:**
   - What is TerminalX's real peak-to-seat ratio across time zones? This is the
     single biggest lever for self-hosting (§2.5).
   - What do TerminalX sandboxes actually use (CPU and RAM)? Boat's published
     fleet averages are 11% CPU and 23% RAM.

## 10. What could not be verified

- **Boat:** the hypervisor; a per-GB disk price; whether "GB" means GB or GiB.
- **Daytona:** the VM hypervisor; per-second figures (only hourly rates are
  published); whether its current images run without Daytona's control plane.
- **E2B:**
  - the price of disk above 20 GiB on Pro ("contact support");
  - the Enterprise minimum ($3,000 on pricing.md vs a $2,000 commit in the HTML
    calculator);
  - pause and resume timings on self-hosted Embed (only E2B Cloud figures are
    published);
  - whether the S3 storage provider accepts a custom endpoint such as Hetzner
    Object Storage.
- **InstaBox:** regions; VAT.
- **Boxd:** location beyond "EU-hosted"; the machine quota (50 in the docs, 100
  on the pricing page); the self-host licence price.
- **Hetzner:**
  - actual stock of LTD products (the `available_configurations` endpoint
    returned 404). On 2026-11-01 the shop did not list them at all (§2.7);
  - whether a given auction AX161 accepts the RAM and drive add-ons. Hetzner
    says to confirm with its product advisors before ordering; this note did
    not open a ticket;
  - the cost of reaching 1 TB on an AX161 with 64 GB modules, which needs the
    four 32 GB base modules swapped. That is not on the price list;
  - the EPYC 7502P thread count from AMD's own page (two fetches timed out).
    It is taken from Hetzner's archived AX161 page ("32 cores and Simultaneous
    Multithreading");
  - whether Hetzner's installimage kernels ship `nbd`;
  - AX42 (Ryzen 7 PRO 8700GE) and EX44 (i5-13500) thread counts from vendor
    pages (AMD returned 404; Intel ARK was not reachable for that SKU), so they
    are derived from Hetzner's text;
  - any 2025 price change (none found; the pressroom archive is JS-rendered);
  - an inconsistency in Hetzner's own table: AX42-1-LTD is listed at "77.30"
    USD in the docs but $87.10 in the price API. The calculator uses the API.
- **Cua:** per-credit dollar value of the historical Cua Cloud plans; what
  local `suspend` preserves.
- **OpenSandbox:** fast-sandbox source not inspected.
- **Proxmox VE:** release cadence (source is not on GitHub).
- **Coder:** the Premium price (only in-repo docs were read).
- **TerminalX's own utilisation and peak-to-seat ratio:** not measured; U1 is
  an assumption.

---

## Appendix A: calculator script (verbatim)

Run with `python3 sandbox_cost_calc.py`. It uses only the standard library and
prints every table above (T1–T8, B1–B5).

```python
#!/usr/bin/env python3
"""Sandbox hosting calculator: Hetzner dedicated servers vs managed sandbox providers.

Every price and spec in FACTS below is cited in docs/SANDBOX-HOSTING-HETZNER.md
(retrieved 2026-10-30). Everything in PARAMS is an assumption: change it and rerun.
Standard library only.  Run:  python3 sandbox_cost_calc.py
"""
import math

# ----------------------------------------------------------------------------
# FACTS (cited in the document; retrieved 2026-10-30)
# ----------------------------------------------------------------------------
ECB_USD_PER_EUR = 1.1172            # ECB euro reference rate, 2026-10-30
HOURS_PER_MONTH = 730               # convention used by Boat ("730 h") and this model

# Hetzner primary IPv4 per dedicated server, per month (docs "IP pricing")
IPV4 = {"EUR": 1.70, "USD": 1.90}

# Hetzner dedicated servers. Monthly price EXCLUDES IPv4 and VAT.
# (threads, ram_gib, [(count, TB_decimal)], ecc, eur_month, eur_setup, usd_month, usd_setup)
# Prices: website-price-api.hetzner.com / live_data_prices.json, matching docs "Price Adjustment 15 June 2026".
# Threads: amd.com / intel.com spec pages (AX42 and EX44 derived from Hetzner's own core/SMT text).
SERVERS = {
    "AX41-1":      (12,  64, [(2, 0.512)], "no",      57.30,   0.00,   67.10,   0.00),
    "AX42-1":      (16,  64, [(2, 0.512)], "no",      97.30,  49.00,  117.10,  59.00),
    "AX102-1":     (32, 128, [(2, 1.92)],  "no",     257.30, 129.00,  302.10, 149.00),
    "AX102-3":     (32, 128, [(2, 1.92)],  "ECC",    452.30, 224.00,  532.10, 264.00),
    "AX102-2":     (32, 192, [(2, 1.92)],  "ECC",    547.30, 274.00,  642.10, 319.00),
    "AX162-1":     (96, 128, [(2, 3.84)],  "ECC reg", 612.30, 304.00, 722.10, 359.00),
    "AX162-2":     (96, 256, [(2, 1.92)],  "ECC reg", 842.30, 419.00, 992.10, 494.00),
    "AX162-3":     (96, 512, [(4, 3.84)],  "ECC reg", 1597.30, 799.00, 1897.10, 949.00),
    "EX44-1":      (20,  64, [(2, 0.512)], "no",      57.30,   0.00,   72.10,   0.00),
    "EX63-1":      (20,  64, [(2, 1.0)],   "no",     147.30,  74.00,  172.10,  84.00),
    "EX63-2":      (20, 192, [(2, 1.92)],  "ECC",    537.30, 269.00,  632.10, 314.00),
    "EX131-1":     (64, 128, [(2, 1.92)],  "ECC reg", 557.30, 279.00, 667.10, 334.00),
    "EX131-2":     (64, 256, [(4, 3.84)],  "ECC reg", 1077.30, 539.00, 1297.10, 649.00),
    # "-LTD" limited offerings: same hardware class, sold only while cheap stock lasts.
    "AX102-1-LTD": (32, 128, [(2, 1.92)],  "no",     157.30,  39.00,  187.10,  39.00),
    "AX102-3-LTD": (32, 128, [(2, 1.92)],  "ECC",    277.30,  39.00,  332.10,  39.00),
    "AX162-1-LTD": (96, 128, [(2, 3.84)],  "ECC reg", 317.30,  39.00, 372.10,  39.00),
    "AX162-2-LTD": (96, 256, [(2, 1.92)],  "ECC reg", 317.30,  39.00, 372.10,  39.00),
    "EX131-1-LTD": (64, 128, [(2, 1.92)],  "ECC reg", 267.30,  39.00, 312.10,  39.00),
}

# Server Auction units listed on 2026-10-30 (live_data_sb.json), the ones with NVMe and >=128 GB RAM
# or the cheapest per GB. Each entry is ONE physical unit (finite stock). No setup fee.
# (label, threads, ram_gib, disks, ecc, eur_month, usd_month)
AUCTION_UNITS = [
    ("SB i7-8700 128G #1",  12, 128, [(2, 1.0)], "no", 118.0, 131.0),
    ("SB i7-8700 128G #2",  12, 128, [(2, 1.0)], "no", 118.0, 131.0),
    ("SB i7-8700 128G #3",  12, 128, [(2, 1.0)], "no", 120.0, 134.0),
    ("SB i9-9900K 128G #1", 16, 128, [(2, 1.0)], "no", 145.0, 161.0),
    ("SB i9-9900K 128G #2", 16, 128, [(2, 1.0)], "no", 149.0, 166.0),
    ("SB R9-5950X 128G #1", 32, 128, [(2, 3.84)], "ECC", 334.0, 371.0),
    ("SB R9-5950X 128G #2", 32, 128, [(2, 3.84)], "ECC", 338.0, 376.0),
    ("SB R7-7700 192G",     16, 192, [(2, 1.0)], "ECC", 351.0, 390.0),
]

# Hetzner Storage Box (EUR/month, excl. VAT): (TB, price)
STORAGE_BOX = [(1, 3.20), (5, 10.90), (10, 20.80), (20, 40.60)]

# Sandbox shapes: (vcpu, ram_gib, disk_gib).  Boat sizes are "GB" on boat.dev; treated as GiB
# here (conservative for the self-host side). Boat disk excludes the OS, which a shared
# copy-on-write base image covers on the self-host side.
PROFILES = {
    "Profile A":    (2, 4, 20),
    "Profile B":    (4, 8, 40),
    "Boat small":   (2, 4, 51),
    "Boat default": (4, 8, 51),
    "Boat large":   (8, 16, 111),
    "Boat xlarge":  (16, 32, 251),
}

# ----------------------------------------------------------------------------
# PARAMS (assumptions; every one is a knob)
# ----------------------------------------------------------------------------
PARAMS = dict(
    host_reserve_fixed_gib=4.0,     # host OS + node agent + networking
    host_reserve_frac=0.06,         # plus 6% of RAM for page cache / safety margin
    host_reserve_threads=2,         # threads kept for the host per server
    vmm_overhead_gib=0.10,          # per-sandbox VMM/page-table overhead (microVM class)
    ram_overcommit=1.0,             # keep RAM at 1x
    disk_raid_usable_frac=0.5,      # RAID1 (2 disks) / RAID10 (4 disks)
    disk_os_reserve_gib=100.0,      # OS, base images, snapshot staging per server
    disk_overcommit=1.0,            # 1.0 = thick; thin provisioning would raise it
    control_plane_ram_gib=16.0,     # platform control plane (API, DB, scheduler) on the fleet
    control_plane_threads=4,
    usage_hours_weekday=8,          # usage pattern U1: 8 active h per weekday per seat
    stored_ratio=2.0,               # suspended workspaces kept per peak-concurrent sandbox
    engineer_month_usd=15000.0,     # fully loaded engineer cost per month (assumption)
    setup_amortize_months=12,
)
U1_HOURS = PARAMS["usage_hours_weekday"] * 5 * 52 / 12      # 173.33 h/month
U_ALWAYS = HOURS_PER_MONTH                                   # 730 h/month
OPS_CASES = {   # FTE per month for build (amortised) + run; assumption, see doc
    "hardware only": 0.0,
    "lean ops (0.5 FTE)": 0.5,
    "realistic ops (1.0 FTE)": 1.0,
}

# ----------------------------------------------------------------------------
# Managed providers: (run $/h, idle $/h) for a (vcpu, ram, disk) shape, plus plan rules.
# All USD.  Rates as published; see the doc for each URL.
# ----------------------------------------------------------------------------
def e2b(v, r, d):        # $0.000014/vCPU-s, $0.0000045/GiB-s; paused = free; disk incl. (20 GiB Pro)
    return (v * 0.000014 + r * 0.0000045) * 3600, 0.0

def daytona(v, r, d):    # $0.0504/vCPU-h, $0.0162/GiB-h, disk $0.000108/GiB-h after 5 GiB free
    disk = max(0, d - 5) * 0.000108
    return v * 0.0504 + r * 0.0162 + disk, disk      # stopped/paused: reserved disk only

def boxd(v, r, d):       # USD card: $0.047/vCPU-h (size), $0.014/GiB-h resident RAM, $0.000096/GiB-h written disk
    # sizes are 1/4, 2/8, 4/16, 8/32 (vCPU/GiB): pick the size with the profile's vCPU;
    # RAM billed on resident memory, taken as the profile's RAM; hibernated = written disk only
    return v * 0.047 + r * 0.014 + d * 0.000096, d * 0.000096

def instabox(v, r, d):   # $0.004/vCPU-h, $0.00225/GiB-h, $0.00011/GiB-h beyond first 20 GiB
    disk = max(0, d - 20) * 0.00011                    # billed while disk exists, paused memory free
    return v * 0.004 + r * 0.00225 + disk, disk

BOAT_RATE = {"Boat small": 0.018, "Boat default": 0.036, "Boat large": 0.072, "Boat xlarge": 0.200}
def boat_shape(profile):   # nearest fixed size
    return {"Profile A": "Boat small", "Profile B": "Boat default"}.get(profile, profile)
def boat(profile):         # stopped = free (disk kept 14 days); per-second while running
    return BOAT_RATE[boat_shape(profile)], 0.0

# Plan rules -> (monthly floor or fee, kind, concurrency limit); None = custom / not published
BOAT_PLANS = [(20, 100), (100, 300), (500, 1000), (2000, 2000)]   # plan $ is returned as VM time
INSTABOX_PLANS = [(20, 100), (100, 200), (500, 500)]              # fee returned as credits
E2B_PLANS = [(150, 100), (650, 600), (1150, 1100)]                # Pro, Pro+, Pro++ (fees, not credits)
DAYTONA_TIER4 = dict(vcpu=500, ram=1000, disk=5000)               # pooled org limits, Tier 4

def managed_month(provider, profile, n, hours):
    """Monthly USD for n sandboxes that each run `hours` h/month and sit idle the rest.
    Returns (cost, note)."""
    v, r, d = PROFILES[profile]
    idle_h = HOURS_PER_MONTH - hours
    if provider == "Boat":
        run, idle = boat(profile)
        usage = n * (hours * run + idle_h * idle)
        if boat_shape(profile) == "Boat xlarge" and usage < 100:
            usage = 100.0
        for price, conc in BOAT_PLANS:
            if conc >= n:
                return max(price, usage), f"${price} plan (credited)"
        return None, "over 2,000 concurrent: not published"
    if provider == "InstaBox":
        run, idle = instabox(v, r, d)
        usage = n * (hours * run + idle_h * idle)
        for price, conc in INSTABOX_PLANS:
            if conc >= n:
                return max(price, usage), f"${price} plan (credited)"
        return None, "over 500 running: Enterprise, not published"
    if provider == "E2B":
        run, idle = e2b(v, r, d)
        usage = n * (hours * run + idle_h * idle)
        for fee, conc in E2B_PLANS:
            if conc >= n:
                note = "Pro" if fee == 150 else f"Pro + concurrency add-on (${fee} total fees)"
                if d > 20:
                    note += "; disk >20 GiB needs support (price not published)"
                return usage + fee, note
        return None, "over 1,100 concurrent: Enterprise, not published"
    if provider == "Daytona":
        run, idle = daytona(v, r, d)
        usage = n * (hours * run + idle_h * idle)
        note = "per-sandbox disk above default 10 GB cap needs a raise"
        stored = n * (1 + PARAMS["stored_ratio"])
        if n * v > DAYTONA_TIER4["vcpu"] or n * r > DAYTONA_TIER4["ram"] or stored * d > DAYTONA_TIER4["disk"]:
            note += "; exceeds Tier 4 pool (custom)"
        return usage, note
    if provider == "Boxd":
        run, idle = boxd(v, r, d)
        usage = n * (hours * run + idle_h * idle)
        note = "size with profile vCPU (RAM:vCPU fixed at 4:1)"
        if n > 100:
            note += "; >100 machines needs Boxd to raise the org quota (docs say 50)"
        return usage, note
    raise ValueError(provider)

MANAGED = ["Boat", "InstaBox", "Boxd", "E2B", "Daytona"]

def run_rate(provider, profile):
    v, r, d = PROFILES[profile]
    return {"Boat": lambda: boat(profile), "InstaBox": lambda: instabox(v, r, d),
            "Boxd": lambda: boxd(v, r, d), "E2B": lambda: e2b(v, r, d),
            "Daytona": lambda: daytona(v, r, d)}[provider]()

# ----------------------------------------------------------------------------
# Hetzner capacity model
# ----------------------------------------------------------------------------
def gib_from_tb(tb):
    return tb * 1e12 / 2**30

def server_caps(threads, ram, disks, cp=False):
    p = PARAMS
    ram_av = ram - (p["host_reserve_fixed_gib"] + p["host_reserve_frac"] * ram)
    thr_av = threads - p["host_reserve_threads"]
    if cp:
        ram_av -= p["control_plane_ram_gib"]
        thr_av -= p["control_plane_threads"]
    raw = sum(n * gib_from_tb(tb) for n, tb in disks)
    disk_av = raw * p["disk_raid_usable_frac"] - p["disk_os_reserve_gib"]
    return ram_av, thr_av, disk_av

def fits(caps, profile, cpu_oc):
    v, r, d = PROFILES[profile]
    ram_av, thr_av, disk_av = caps
    by = {
        "RAM": math.floor(ram_av * PARAMS["ram_overcommit"] / (r + PARAMS["vmm_overhead_gib"])),
        "CPU": math.floor(thr_av * cpu_oc / v),
        "disk": math.floor(disk_av * PARAMS["disk_overcommit"] / d),
    }
    n = max(0, min(by.values()))
    return n, min(by, key=by.get)

def fleet_capacity(units, profile, cpu_oc, n_plus_1):
    """units: list of (label, threads, ram, disks). Control plane sits on the first unit.
    N+1 leaves the largest-capacity unit empty as the spare."""
    per = []
    for i, (lab, thr, ram, disks) in enumerate(units):
        per.append(fits(server_caps(thr, ram, disks, cp=(i == 0)), profile, cpu_oc))
    total = sum(n for n, _ in per)
    if n_plus_1 and len(units) > 1:
        # spare = the unit that would hold the most sandboxes without the control plane
        best = max(range(len(units)), key=lambda i: fits(server_caps(*units[i][1:]), profile, cpu_oc)[0])
        total -= per[best][0]
        if best == 0:   # control plane moves to the next unit: recompute it with the CP
            nxt = 1
            total -= per[nxt][0]
            total += fits(server_caps(*units[nxt][1:], cp=True), profile, cpu_oc)[0]
    elif n_plus_1:
        total = 0
    binding = sorted({b for _, b in per})
    return total, "/".join(binding)

def unit_price(name, currency):
    t = SERVERS[name]
    m = t[4] if currency == "EUR" else t[6]
    s = t[5] if currency == "EUR" else t[7]
    return m + IPV4[currency], s

def to_usd(amount, currency, mode):
    """mode 'USD list' = Hetzner's own USD price; 'EUR@ECB' = EUR price x ECB rate."""
    return amount if currency == "USD" else amount * ECB_USD_PER_EUR

def storage_box_eur(tb_needed):
    """Cheapest combination of Storage Boxes (greedy on the 20 TB box, then the smallest that fits)."""
    cost, left = 0.0, tb_needed
    while left > 20:
        cost += 40.60; left -= 20
    for tb, price in STORAGE_BOX:
        if left <= tb:
            return cost + price
    return cost + 40.60

def snapshot_tb(n_peak, profile):
    v, r, d = PROFILES[profile]
    per = d + r                       # disk image + memory snapshot per stored workspace
    return n_peak * (1 + PARAMS["stored_ratio"]) * per * 2**30 / 1e12

# ----------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------
def md(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)

def money(x):
    return "n/a" if x is None else f"${x:,.2f}"

def rate(x):
    return f"${x:.4f}"

def report_server_capacity():
    print("\n## T1. Sandboxes per server (control plane not placed), binding limit\n")
    rows = []
    for name, (thr, ram, disks, ecc, em, es, um, us) in SERVERS.items():
        caps = server_caps(thr, ram, disks)
        row = [name, thr, ram, f"{sum(n*tb for n,tb in disks):.2f} TB", ecc,
               f"€{em+IPV4['EUR']:.2f} / ${um+IPV4['USD']:.2f}"]
        for prof in ("Profile A", "Profile B"):
            for oc in (1, 2, 4):
                n, b = fits(caps, prof, oc)
                row.append(f"{n} {b}")
        rows.append(row)
    print(md(rows, ["server", "threads", "RAM GiB", "NVMe raw", "ECC", "month incl. IPv4 (EUR / USD list)",
                    "A 1x", "A 2x", "A 4x", "B 1x", "B 2x", "B 4x"]))

def hetzner_slot_month_usd(name, profile, cpu_oc, mode):
    cur = "USD" if mode == "USD list" else "EUR"
    m, _ = unit_price(name, cur)
    thr, ram, disks = SERVERS[name][:3]
    n, b = fits(server_caps(thr, ram, disks), profile, cpu_oc)
    return to_usd(m, cur, mode) / n, n, b

def report_per_hour():
    print("\n## T2. Managed run rate per sandbox-hour (USD) and idle rate\n")
    rows = []
    for prof in ("Profile A", "Profile B"):
        for p in MANAGED:
            run, idle = run_rate(p, prof)
            shape = boat_shape(prof) if p == "Boat" else prof
            rows.append([prof, p, shape, rate(run), rate(idle),
                         money(run * U1_HOURS + idle * (HOURS_PER_MONTH - U1_HOURS)),
                         money(run * HOURS_PER_MONTH)])
    print(md(rows, ["profile", "provider", "shape billed", "run $/h", "idle $/h",
                    f"seat-month U1 ({U1_HOURS:.1f} h)", "seat-month always-on"]))

    print("\n## T3. Hetzner hardware-only cost per sandbox-hour at fleet utilisation u (USD list prices, 2x CPU overcommit, no N+1, no ops)\n")
    rows = []
    for name in ("AX102-1", "AX102-3", "AX162-2", "AX162-3", "AX42-1", "AX102-1-LTD", "AX162-2-LTD"):
        for prof in ("Profile A", "Profile B"):
            per, n, b = hetzner_slot_month_usd(name, prof, 2, "USD list")
            cells = [name, prof, f"{n} ({b})", money(per)]
            for u in (1.0, 0.5, U1_HOURS / HOURS_PER_MONTH):
                cells.append(rate(per / (HOURS_PER_MONTH * u)))
            rows.append(cells)
    print(md(rows, ["server", "profile", "per server", "$/slot-month", "u=100%", "u=50%",
                    f"u={U1_HOURS/HOURS_PER_MONTH:.1%} (U1)"]))

def fleet_month_usd(n_peak, profile, server, cpu_oc, mode, ops_fte):
    """Servers for n_peak with N+1, control plane, IPv4, storage boxes, ops."""
    cur = "USD" if mode == "USD list" else "EUR"
    thr, ram, disks = SERVERS[server][:3]
    plain = fits(server_caps(thr, ram, disks), profile, cpu_oc)[0]
    with_cp = fits(server_caps(thr, ram, disks, cp=True), profile, cpu_oc)[0]
    # homogeneous fleet of k units with N+1: one spare, control plane on one working unit
    # capacity(k) = with_cp + (k - 2) * plain  for k >= 2   (same result as fleet_capacity)
    if plain <= 0:
        raise ValueError(f"{server} cannot hold one {profile}")
    k = 2 + max(0, math.ceil((n_peak - with_cp) / plain))
    m, s = unit_price(server, cur)
    hw = to_usd(m * k, cur, mode)
    sb = storage_box_eur(snapshot_tb(n_peak, profile)) * ECB_USD_PER_EUR
    ops = ops_fte * PARAMS["engineer_month_usd"]
    setup = to_usd(s * k, cur, mode)
    return dict(servers=k, hw=hw, storage=sb, ops=ops, setup=setup,
                setup_amort=setup / PARAMS["setup_amortize_months"],
                total=hw + sb + ops + setup / PARAMS["setup_amortize_months"])

def report_scenarios(server="AX102-1", cpu_oc=2, mode="USD list"):
    print(f"\n## T4. Scenarios: {server}, {cpu_oc}x CPU overcommit, N+1, {mode}\n")
    rows = []
    for prof in ("Profile A", "Profile B"):
        for n in (10, 50, 200, 1000):
            f = fleet_month_usd(n, prof, server, cpu_oc, mode, 0.0)
            cells = [prof, n, f["servers"], money(f["hw"]), money(f["storage"]), money(f["setup"]),
                     money(f["hw"] + f["storage"] + f["setup_amort"])]
            for ops in (0.5, 1.0):
                cells.append(money(f["hw"] + f["storage"] + f["setup_amort"] + ops * PARAMS["engineer_month_usd"]))
            for ops in (0.0, 0.5):
                for hours in (U1_HOURS, U_ALWAYS):
                    tot = f["hw"] + f["storage"] + f["setup_amort"] + ops * PARAMS["engineer_month_usd"]
                    cells.append(rate(tot / (n * hours)))
            rows.append(cells)
    print(md(rows, ["profile", "peak N", "servers (N+1)", "servers/mo", "storage box/mo", "setup once",
                    "hw total/mo (setup /12)", "+0.5 FTE", "+1.0 FTE", "$/sandbox-h U1 (hw)",
                    "$/sandbox-h always-on (hw)", "$/sandbox-h U1 (+0.5 FTE)", "$/sandbox-h always-on (+0.5 FTE)"]))

    print(f"\n## T5. Managed monthly cost at the same peak N (U1 = {U1_HOURS:.1f} h/seat; always-on = 730 h)\n")
    rows = []
    for prof in ("Profile A", "Profile B"):
        for n in (10, 50, 200, 1000):
            for hours, lab in ((U1_HOURS, "U1"), (U_ALWAYS, "always-on")):
                cells = [prof, n, lab]
                for p in MANAGED:
                    c, note = managed_month(p, prof, n, hours)
                    cells.append(money(c))
                rows.append(cells)
    print(md(rows, ["profile", "peak N", "pattern"] + MANAGED))

def break_even(provider, profile, hours, server, cpu_oc, mode, ops_fte, n_max=5000):
    """Smallest peak N (1..n_max) where self-hosting is cheaper per month and stays so
    for all larger N tested at the scenario points. Returns N or None."""
    for n in range(1, n_max + 1):
        c, _ = managed_month(provider, profile, n, hours)
        if c is None:
            return f"none up to {n-1} (self-serve limit)"
        f = fleet_month_usd(n, profile, server, cpu_oc, mode, ops_fte)
        if f["total"] <= c:
            return n
    return None

def report_break_even(server="AX102-1", cpu_oc=2, mode="USD list"):
    print(f"\n## T6. Break-even: first peak N at which self-hosting is cheaper; {server}, {cpu_oc}x CPU, N+1, {mode}\n")
    rows = []
    for prof in ("Profile A", "Profile B"):
        for hours, lab in ((U1_HOURS, "U1"), (U_ALWAYS, "always-on")):
            for ops_lab, fte in OPS_CASES.items():
                cells = [prof, lab, ops_lab]
                for p in MANAGED:
                    be = break_even(p, prof, hours, server, cpu_oc, mode, fte)
                    cells.append("none up to 5000" if be is None else be)
                rows.append(cells)
    print(md(rows, ["profile", "pattern", "ops"] + MANAGED))

# ----------------------------------------------------------------------------
# Budget section: what $1,500 and $2,000 a month buys
# ----------------------------------------------------------------------------
def budget_fleets(budget_usd, mode):
    cur = "USD" if mode == "USD list" else "EUR"
    sb_usd = 20.80 * ECB_USD_PER_EUR                 # one BX31 (10 TB) for backups, always bought
    avail = budget_usd - sb_usd
    fleets = []
    def homog(name):
        m, s = unit_price(name, cur)
        k = int(avail // to_usd(m, cur, mode))
        thr, ram, disks = SERVERS[name][:3]
        return (f"{k}x {name}", [(name, thr, ram, disks)] * k, to_usd(m * k, cur, mode), to_usd(s * k, cur, mode))
    for name in ("AX102-1", "AX102-3", "AX162-1", "AX162-2", "AX162-3", "EX131-1", "AX42-1",
                 "AX102-1-LTD", "AX162-2-LTD"):
        f = homog(name)
        if f[1]:                       # skip a type the budget cannot buy even once
            fleets.append(f)
    # mix: one AX162-2 (256 GB, ECC) plus as many AX102-1 as fit
    m1, s1 = unit_price("AX162-2", cur); m2, s2 = unit_price("AX102-1", cur)
    left = avail - to_usd(m1, cur, mode)
    k2 = int(left // to_usd(m2, cur, mode)) if left > 0 else 0
    if k2 > 0:
        units = [("AX162-2",) + SERVERS["AX162-2"][:3]] + [("AX102-1",) + SERVERS["AX102-1"][:3]] * k2
        fleets.append((f"1x AX162-2 + {k2}x AX102-1", units,
                       to_usd(m1 + m2 * k2, cur, mode), to_usd(s1 + s2 * k2, cur, mode)))
    # Server Auction: cheapest EUR per GiB first, finite stock, no setup fee
    units, spent = [], 0.0
    for lab, thr, ram, disks, ecc, em, um in sorted(AUCTION_UNITS, key=lambda u: u[5] / u[2]):
        price = to_usd((um if cur == "USD" else em) + IPV4[cur], cur, mode)
        if spent + price <= avail:
            units.append((lab, thr, ram, disks)); spent += price
    fleets.append((f"Server Auction ({len(units)} of {len(AUCTION_UNITS)} shortlisted units)", units, spent, 0.0))
    return fleets, sb_usd

def report_budget():
    for mode in ("USD list", "EUR@ECB"):
        for budget in (1500, 2000):
            fleets, sb = budget_fleets(budget, mode)
            print(f"\n## B1. ${budget:,}/month, pricing = {mode} (Storage Box BX31 ${sb:.2f}/mo taken off the top)\n")
            rows = []
            for lab, units, monthly, setup in fleets:
                thr = sum(u[1] for u in units); ram = sum(u[2] for u in units)
                nvme = sum(n * tb for u in units for n, tb in u[3])
                rows.append([lab, len(units), thr, ram, f"{nvme:.2f}", money(monthly), money(monthly + sb),
                             money(setup), money(setup / PARAMS["setup_amortize_months"])])
            print(md(rows, ["fleet", "servers", "threads", "RAM GiB", "NVMe TB raw", "servers+IPv4 /mo",
                            "incl. Storage Box /mo", "setup once", "setup /12 mo"]))
            for shape_set, title in ((("Boat small", "Boat default", "Boat large", "Boat xlarge"), "Boat sizes"),
                                     (("Profile A", "Profile B"), "Profiles A/B")):
                print(f"\n### B2. ${budget:,}/mo ({mode}): concurrent sandboxes per fleet, {title}; cells = without N+1 / with N+1 (binding)\n")
                rows = []
                for lab, units, monthly, setup in fleets:
                    for prof in shape_set:
                        cells = [lab, prof]
                        for oc in (1, 2, 4):
                            a, b = fleet_capacity(units, prof, oc, False)
                            c, _ = fleet_capacity(units, prof, oc, True)
                            cells.append(f"{a} / {c} ({b})")
                        rows.append(cells)
                print(md(rows, ["fleet", "shape", "1x CPU", "2x CPU", "4x CPU"]))

def managed_for_budget(provider, profile, budget, hours):
    """Max concurrent seats a monthly budget sustains (each seat runs `hours`), within plan limits."""
    lo, best = 1, 0
    for n in range(1, 200000):
        c, _ = managed_month(provider, profile, n, hours)
        if c is None or c > budget:
            break
        best = n
    return best

def report_budget_managed():
    print("\n## B3. What the same budget buys on managed providers (concurrent seats; sandbox-hours)\n")
    rows = []
    for budget in (1500, 2000):
        for prof in ("Boat small", "Boat default", "Boat large", "Boat xlarge", "Profile A", "Profile B"):
            providers = ["Boat"] if prof.startswith("Boat") else MANAGED
            for p in providers:
                run, idle = (boat(prof) if p == "Boat" else run_rate(p, prof))
                fee = 150.0 if p == "E2B" else 0.0     # E2B Pro fee is not returned as credit
                hours_bought = (budget - fee) / run
                rows.append([f"${budget:,}", prof, p, rate(run), f"{hours_bought:,.0f}",
                             managed_for_budget(p, prof, budget, U_ALWAYS),
                             managed_for_budget(p, prof, budget, U1_HOURS)])
    print(md(rows, ["budget", "shape", "provider", "run $/h", "sandbox-hours if all spent running",
                    "concurrent always-on", f"seats at U1 ({U1_HOURS:.1f} h)"]))

def report_required_utilisation():
    print("\n## T7. Fleet utilisation at which Hetzner hardware alone matches the managed run rate (no N+1, no ops)\n")
    rows = []
    for name in ("AX102-1", "AX102-3", "AX162-2", "AX42-1", "AX102-1-LTD", "AX162-2-LTD"):
        for prof in ("Profile A", "Profile B"):
            for oc in (2, 4):
                per, n, b = hetzner_slot_month_usd(name, prof, oc, "USD list")
                cells = [name, prof, f"{oc}x", f"{n} ({b})", money(per)]
                for p in MANAGED:
                    run, _ = run_rate(p, prof)
                    u = per / (run * HOURS_PER_MONTH)
                    cells.append(f"{u:.0%}" if u <= 1 else f"never ({u:.0%})")
                rows.append(cells)
    print(md(rows, ["server", "profile", "CPU oc", "per server", "$/slot-month"] + MANAGED))

# Hetzner Cloud plans (EUR/h incl. IPv4 as shown on hetzner.com/cloud, excl. VAT): today's per-workspace VM shape
# (EUR per hour, EUR monthly cap)
HCLOUD = {"CPX22 (2 vCPU AMD, 4 GB, 80 GB)": (0.0320, 19.99), "CPX32 (4 vCPU AMD, 8 GB, 160 GB)": (0.0577, 35.99),
          "CX23 (2 vCPU, 4 GB, 40 GB; 'not available')": (0.0096, 5.99),
          "CX33 (4 vCPU, 8 GB, 80 GB; 'not available')": (0.0144, 8.99)}

def report_hcloud():
    print("\n## T8. Hetzner Cloud VM per workspace, converted at the ECB rate (reference only)\n")
    rows = [[k, f"€{h:.4f}", rate(h * ECB_USD_PER_EUR), f"€{m:.2f}", money(m * ECB_USD_PER_EUR)]
            for k, (h, m) in HCLOUD.items()]
    print(md(rows, ["plan", "EUR/h", "USD/h (ECB)", "EUR monthly cap", "USD monthly cap (ECB)"]))

def report_sensitivity():
    """Same fleets, Boat sizes, with thin-provisioned disk (2x) and modest RAM overcommit (1.25x)."""
    saved = dict(PARAMS)
    PARAMS.update(disk_overcommit=2.0, ram_overcommit=1.25)
    for budget in (1500, 2000):
        fleets, _ = budget_fleets(budget, "USD list")
        print(f"\n## B4. Sensitivity, ${budget:,}/mo USD list: disk 2x thin, RAM 1.25x, CPU 4x; without / with N+1 (binding)\n")
        rows = []
        for lab, units, monthly, setup in fleets:
            cells = [lab]
            for prof in ("Boat small", "Boat default", "Boat large", "Boat xlarge"):
                a, b = fleet_capacity(units, prof, 4, False)
                c, _ = fleet_capacity(units, prof, 4, True)
                cells.append(f"{a} / {c} ({b})")
            rows.append(cells)
        print(md(rows, ["fleet", "Boat small", "Boat default", "Boat large", "Boat xlarge"]))
    PARAMS.clear(); PARAMS.update(saved)
    PARAMS.update(disk_overcommit=2.0, ram_overcommit=2.0)
    print("\n## B5. Aggressive (Boat-like) overcommit, $1,500 and $2,000 USD list: disk 2x, RAM 2x, CPU 4x; without / with N+1\n")
    rows = []
    for budget in (1500, 2000):
        fleets, _ = budget_fleets(budget, "USD list")
        for lab, units, monthly, setup in fleets:
            if not lab.startswith(("6x AX102-1", "4x AX102-1", "3x AX162-2-LTD", "5x AX162-2-LTD", "1x AX162-2 +")):
                continue
            cells = [f"${budget:,}", lab]
            for prof in ("Boat small", "Boat default", "Boat large", "Boat xlarge"):
                a, b = fleet_capacity(units, prof, 4, False)
                c, _ = fleet_capacity(units, prof, 4, True)
                cells.append(f"{a} / {c} ({b})")
            rows.append(cells)
    print(md(rows, ["budget", "fleet", "Boat small", "Boat default", "Boat large", "Boat xlarge"]))
    PARAMS.clear(); PARAMS.update(saved)

if __name__ == "__main__":
    print(f"# Calculator output  (ECB {ECB_USD_PER_EUR} USD/EUR; U1 = {U1_HOURS:.2f} h/month)")
    print("PARAMS:", PARAMS)
    report_server_capacity()
    report_per_hour()
    report_scenarios("AX102-1", 2, "USD list")
    report_break_even("AX102-1", 2, "USD list")
    report_scenarios("AX162-2-LTD", 2, "USD list")
    report_break_even("AX162-2-LTD", 2, "USD list")
    report_budget()
    report_required_utilisation()
    report_hcloud()
    report_budget_managed()
    report_sensitivity()
```

---

## Appendix B: server-pick calculator (verbatim, 2026-11-01)

Run with `python3 server_pick.py`. It uses only the standard library and
prints the §2.7 summary matrix, the full per-scenario rankings, and the
budget fleets.

```python
#!/usr/bin/env python3
"""Which Hetzner dedicated server hosts Boat-size sandboxes cheapest?

Facts retrieved 2026-11-01 (USD list prices, excl. VAT):
- New server types: hetzner.com live_data_prices.json + product/<MODEL>_en.json
  ("Server types offer fixed hardware configurations that cannot be modified
  after ordering"; docs ax-server / ex-server: "You cannot order additional hardware").
- Auction units: hetzner.com live_data_sb.json. Add-ons may be requested after
  delivery (docs server-auction-faqs).
- Add-on prices: docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/
  (last change 2026-10-07).
- AX161 = AMD EPYC 7502P, 32 cores + SMT, up to 8 disks (archived hetzner.com/dedicated-rootserver/ax161,
  2024-02-23); RAM upgrade "per 32 GB DDR4 Reg. ECC steps max. 512 GB" (docs ax-server).
Standard library only.
"""
import itertools, math

IPV4 = 1.90

# name: (threads, ram_gib, [(count, TB)], usd_month, usd_setup)
NEW = {
    "AX42-1":  (16,  64, [(2, 0.512)], 117.10,  59.00),
    "AX102-1": (32, 128, [(2, 1.92)],  302.10, 149.00),
    "AX102-2": (32, 192, [(2, 1.92)],  642.10, 319.00),
    "AX102-4": (32, 128, [(2, 1.92), (2, 7.68)], 892.10, 449.00),
    "AX162-1": (96, 128, [(2, 3.84)],  722.10, 359.00),
    "AX162-2": (96, 256, [(2, 1.92)],  992.10, 494.00),
    "AX162-4": (96, 256, [(2, 1.92), (2, 15.36)], 1297.10, 649.00),
    "AX162-3": (96, 512, [(4, 3.84)], 1897.10, 949.00),
    "EX63-1":  (20,  64, [(2, 1.0)],   172.10,  84.00),
    "EX63-2":  (20, 192, [(2, 1.92)],  632.10, 314.00),
    "EX131-1": (64, 128, [(2, 1.92)],  667.10, 334.00),
    "EX131-2": (64, 256, [(4, 3.84)], 1297.10, 649.00),
}
# Priced by website-price-api but absent from the shop's live price feed on 2026-11-01.
LTD = {
    "AX102-1-LTD": (32, 128, [(2, 1.92)], 187.10, 39.00),
    "AX162-2-LTD": (96, 256, [(2, 1.92)], 372.10, 39.00),
}
# Auction AX161 (EPYC 7502P) units listed 2026-11-01: (id, usd_month, existing drives)
AX161_UNITS = [
    ("SB#3104641", 381.0, [(1, 0.96)]),
    ("SB#3104321", 399.0, [(1, 0.96)]),
    ("SB#3104635", 423.0, [(1, 1.92)]),
    ("SB#3104306", 438.0, [(2, 0.96)]),
    ("SB#3104626", 530.0, [(2, 3.84)]),
]
AX161_THREADS, AX161_BASE_RAM, AX161_MAX_RAM, AX161_MAX_DRIVES = 64, 128, 512, 8
RAM_STEP_32_DDR4_REG = 22.0                      # $/month per +32 GB step
NVME_DC = {0.96: 45.0, 1.92: 83.0, 3.84: 114.0, 7.68: 201.0}   # $/month per drive (AX161 takes 960 GB-7.68 TB)

SHAPES = {"Boat small": (2, 4, 51), "Boat default": (4, 8, 51)}

P = dict(host_reserve_fixed_gib=4.0, host_reserve_frac=0.06, host_reserve_threads=2,
         vmm_overhead_gib=0.10, os_reserve_gb=100.0, setup_amortize_months=12)


def raid_usable_gb(drives):
    """Pairs in RAID1 / RAID10: half the raw capacity of drives that come in pairs."""
    return sum((n // 2) * 2 * tb * 1000 / 2 for n, tb in drives)


def slots(threads, ram, disk_gb, shape, cpu_k, disk_k):
    v, r, d = shape
    ram_free = ram - P["host_reserve_fixed_gib"] - P["host_reserve_frac"] * ram
    by_ram = math.floor(ram_free / (r + P["vmm_overhead_gib"]))
    by_cpu = math.floor((threads - P["host_reserve_threads"]) * cpu_k / v)
    by_disk = math.floor(max(0.0, disk_gb - P["os_reserve_gb"]) * disk_k / d)
    n = min(by_ram, by_cpu, by_disk)
    limit = "/".join(k for k, x in (("RAM", by_ram), ("CPU", by_cpu), ("disk", by_disk)) if x == n)
    return n, limit


def best_ax161(unit, shape, cpu_k, disk_k):
    """Cheapest RAM + drive add-ons for one auction AX161 unit, by $ per slot."""
    uid, price, existing = unit
    used_bays = sum(n for n, _ in existing)
    best = None
    for ram in range(AX161_BASE_RAM, AX161_MAX_RAM + 1, 32):
        ram_cost = (ram - AX161_BASE_RAM) / 32 * RAM_STEP_32_DDR4_REG
        options = [((), 0.0)]
        for tb, cost in NVME_DC.items():
            for count in (2, 4, 6):
                if used_bays + count <= AX161_MAX_DRIVES:
                    options.append((((count, tb),), count * cost))
        for added, drive_cost in options:
            disk = raid_usable_gb(existing + list(added))
            n, limit = slots(AX161_THREADS, ram, disk, shape, cpu_k, disk_k)
            if n == 0:
                continue
            month = price + IPV4 + ram_cost + drive_cost
            cand = (month / n, n, month, ram, added, limit)
            if best is None or cand[0] < best[0]:
                best = cand
    per_slot, n, month, ram, added, limit = best
    adds = f"+RAM to {ram} GB" if ram > AX161_BASE_RAM else "no RAM add-on"
    adds += "".join(f", +{c}x{tb} TB NVMe" for c, tb in added)
    return dict(name=f"AX161 auction {uid}", n=n, month=month, setup=0.0, limit=limit, note=adds)


def new_server(name, spec, shape, cpu_k, disk_k):
    threads, ram, drives, month, setup = spec
    n, limit = slots(threads, ram, raid_usable_gb(drives), shape, cpu_k, disk_k)
    return dict(name=name, n=n, month=month + IPV4, setup=setup, limit=limit, note="fixed hardware")


def rows(shape, cpu_k, disk_k, include_ltd=False):
    out = [new_server(k, s, shape, cpu_k, disk_k) for k, s in NEW.items()]
    if include_ltd:
        out += [new_server(k, s, shape, cpu_k, disk_k) for k, s in LTD.items()]
    out += [best_ax161(u, shape, cpu_k, disk_k) for u in AX161_UNITS]
    for r in out:
        r["per_slot"] = r["month"] / r["n"] if r["n"] else float("inf")
        r["per_slot_setup"] = (r["month"] + r["setup"] / P["setup_amortize_months"]) / r["n"] if r["n"] else float("inf")
        r["per_hour"] = r["per_slot"] / 730
    return sorted(out, key=lambda r: r["per_slot_setup"])


def table(shape_name, cpu_k, disk_k, include_ltd=False, top=None):
    rs = rows(SHAPES[shape_name], cpu_k, disk_k, include_ltd)
    print(f"\n### {shape_name}, CPU {cpu_k}x, disk {'thick' if disk_k == 1 else f'thin {disk_k}x'}, RAM 1x")
    print("| server | slots | binding | $/month (incl. IPv4 + add-ons) | $/slot-month | + setup/12 | $/slot-hour at 100% | add-ons |")
    print("|---|---|---|---|---|---|---|---|")
    for r in rs[:top]:
        print(f"| {r['name']} | {r['n']} | {r['limit']} | {r['month']:,.2f} | {r['per_slot']:.2f} | {r['per_slot_setup']:.2f} | {r['per_hour']:.4f} | {r['note']} |")


def fleet(budget, shape_name, cpu_k, disk_k, keep_spare):
    """Most slots within a monthly budget: any count of one or two new types plus any subset of auction units.
    keep_spare=True maximises the count left after losing the largest server (N+1)."""
    shape = SHAPES[shape_name]
    new = {k: new_server(k, s, shape, cpu_k, disk_k) for k, s in NEW.items()}
    auction = [best_ax161(u, shape, cpu_k, disk_k) for u in AX161_UNITS]
    best = None
    names = list(new)
    for mask in range(1 << len(auction)):
        picked = [a for i, a in enumerate(auction) if mask >> i & 1]
        a_month = sum(a["month"] for a in picked)
        if a_month > budget:
            continue
        for t1, t2 in itertools.combinations_with_replacement(names + [None], 2):
            for c1 in range(0, 20):
                for c2 in range(0, 20 if t2 else 1):
                    parts = [(new[t1], c1)] if t1 else []
                    if t2:
                        parts.append((new[t2], c2))
                    month = a_month + sum(r["month"] * c for r, c in parts)
                    if month > budget:
                        break
                    servers = [a for a in picked] + [r for r, c in parts for _ in range(c)]
                    if not servers:
                        continue
                    total = sum(s["n"] for s in servers)
                    spare = total - max(s["n"] for s in servers) if len(servers) > 1 else 0
                    setup = sum(s["setup"] for s in servers)
                    key = (spare, total, -month) if keep_spare else (total, spare, -month)
                    if best is None or key > best[0]:
                        best = (key, spare, total, -month, servers, setup)
    _, spare, total, neg_month, servers, setup = best
    counts = {}
    for s in servers:
        key = s["name"] if not s["name"].startswith("AX161") else "AX161 auction (" + s["note"] + ")"
        counts[key] = counts.get(key, 0) + 1
    desc = " + ".join(f"{c}x {k}" for k, c in counts.items())
    goal = "with spare" if keep_spare else "max count"
    disk = "thick" if disk_k == 1 else f"thin {disk_k}x"
    print(f"| ${budget:,} | {shape_name} | {cpu_k}x | {disk} | {goal} | {desc} | {total} | {spare} | {-neg_month:,.2f} | {setup:,.2f} |")


def summary():
    """$/slot-month (setup amortised) per server across scenarios; AX161 = cheapest listed unit per scenario."""
    scen = [("Boat small", 4, 1), ("Boat small", 4, 2), ("Boat small", 2, 1), ("Boat small", 2, 2),
            ("Boat default", 4, 1), ("Boat default", 2, 1)]
    print("\n### Summary: $ per sandbox-month (setup/12 included), RAM 1x")
    print("| server | $/GB RAM-month | " + " | ".join(f"{s.split()[1]} {k}x CPU {'thick' if d == 1 else 'thin'}" for s, k, d in scen) + " |")
    print("|---|---|" + "---|" * len(scen))
    names = list(NEW) + ["AX161 auction (best unit)"]
    for name in names:
        cells = []
        for s, k, d in scen:
            rs = rows(SHAPES[s], k, d)
            r = min((x for x in rs if x["name"].startswith("AX161")), key=lambda x: x["per_slot_setup"]) \
                if name.startswith("AX161") else next(x for x in rs if x["name"] == name)
            cells.append(f"{r['per_slot_setup']:.2f} ({r['n']})")
        if name.startswith("AX161"):
            per_gb = (AX161_UNITS[0][1] + IPV4 + (AX161_MAX_RAM - AX161_BASE_RAM) / 32 * RAM_STEP_32_DDR4_REG) / AX161_MAX_RAM
        else:
            per_gb = (NEW[name][3] + IPV4) / NEW[name][1]
        print(f"| {name} | {per_gb:.2f} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    summary()
    for cpu_k in (4, 2):
        for disk_k in (1, 2):
            for shape in SHAPES:
                table(shape, cpu_k, disk_k)
    print("\n### With the LTD tier, if Hetzner shows it again (Boat small, CPU 4x, thick)")
    table("Boat small", 4, 1, include_ltd=True, top=6)
    print("\n### Best fleet per budget (CPU 4x, RAM 1x)")
    print("| budget | shape | CPU | disk | goal | fleet | sandboxes | after losing largest server | $/month | setup once |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for budget in (1500, 2000):
        for shape in SHAPES:
            for disk_k in (1, 2):
                for keep_spare in (False, True):
                    fleet(budget, shape, 4, disk_k, keep_spare)
```
