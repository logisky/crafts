// The registry pipeline. Dependency-light ESM (fflate only), run from the
// repo root after `yarn build`.
//
//   node scripts/registry.mjs pack
//       Pack every craft under packages/ into out/<id>-<version>.craft.
//
//   node scripts/registry.mjs verify <index.json URL or path>
//       PR check: no package may change the content of a version that is
//       already published. Changed a craft? Bump its version.
//
//   node scripts/registry.mjs publish <site dir>
//       Merge out/ into a checkout of the gh-pages branch: copy new versions
//       to <site>/packages/<id>/ and rewrite <site>/index.json. Fails, and
//       writes nothing, if a published version would change.
//
// Published versions are immutable. `craftsmith pack` is deterministic, so an
// unchanged craft packs to the same sha256 and is simply skipped; a different
// sha256 under the same version is always an error, never an overwrite.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {strFromU8, unzipSync} from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = path.join(ROOT, 'packages')
const OUT = path.join(ROOT, 'out')
const CRAFTSMITH = path.join(ROOT, 'node_modules', '.bin', 'craftsmith')

/** A workspace is a craft if it has a page or tools; `-core` libraries do not. */
function craftDirs() {
    return fs
        .readdirSync(PACKAGES)
        .map((d) => path.join(PACKAGES, d))
        .filter(
            (d) =>
                fs.existsSync(path.join(d, 'package.json')) &&
                (fs.existsSync(path.join(d, 'index.html')) ||
                    fs.existsSync(path.join(d, 'tools.ts')))
        )
        .sort()
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
}

/** Every packed package in out/, with what the index needs to know. */
function readOut() {
    if (!fs.existsSync(OUT)) throw new Error('no out/ — run `pack` first')
    return fs
        .readdirSync(OUT)
        .filter((f) => f.endsWith('.craft'))
        .sort()
        .map((file) => {
            const bytes = fs.readFileSync(path.join(OUT, file))
            const manifest = JSON.parse(
                strFromU8(unzipSync(bytes)['manifest.json'])
            )
            return {file, bytes, manifest, sha256: sha256(bytes)}
        })
}

async function loadIndex(where) {
    if (/^https?:\/\//.test(where)) {
        const res = await fetch(where)
        // Nothing published yet: every version is new.
        if (res.status === 404) return emptyIndex()
        if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`)
        return res.json()
    }
    return fs.existsSync(where)
        ? JSON.parse(fs.readFileSync(where, 'utf8'))
        : emptyIndex()
}

function emptyIndex() {
    return {schemaVersion: 1, crafts: []}
}

/**
 * Fold the packed packages into `index`. Returns the files to add and the
 * conflicts (a published version whose content changed); mutates `index`.
 */
function merge(index, packed, now) {
    const added = []
    const conflicts = []
    for (const p of packed) {
        const m = p.manifest
        let entry = index.crafts.find((c) => c.craftId === m.craftId)
        if (!entry) {
            entry = {craftId: m.craftId, versions: []}
            index.crafts.push(entry)
        }
        const existing = entry.versions.find((v) => v.version === m.version)
        if (existing) {
            if (existing.sha256 !== p.sha256)
                conflicts.push(
                    `${m.craftId} ${m.version} is already published with different content — bump "version" in packages/*/package.json`
                )
            continue
        }
        const url = `packages/${m.craftId}/${p.file}`
        entry.versions.push({
            version: m.version,
            hostApi: m.hostApi ?? 1,
            // Per version, like hostApi: a later version may need more.
            ...(m.requires?.length ? {requires: m.requires} : {}),
            url,
            sha256: p.sha256,
            size: p.bytes.byteLength,
            publishedAt: now,
        })
        // What a browser shows comes from the newest version.
        Object.assign(entry, {
            label: m.label,
            ...(m.labels ? {labels: m.labels} : {}),
            ...(m.description ? {description: m.description} : {}),
            ...(m.publisher ? {publisher: m.publisher} : {}),
            hasUi: !!m.url,
            ...(m.unlisted ? {unlisted: true} : {}),
            tools: (m.tools ?? []).map((t) => t.name),
        })
        added.push({url, bytes: p.bytes})
    }
    for (const c of index.crafts) {
        c.versions.sort((a, b) => compareVersions(a.version, b.version))
        c.latest = c.versions[c.versions.length - 1]?.version
    }
    index.crafts.sort((a, b) => a.craftId.localeCompare(b.craftId))
    index.schemaVersion = 1
    return {added, conflicts}
}

function compareVersions(a, b) {
    const pa = a.split(/[.+-]/)
    const pb = b.split(/[.+-]/)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? '0'
        const y = pb[i] ?? '0'
        const c =
            isNaN(Number(x)) || isNaN(Number(y))
                ? x.localeCompare(y)
                : Number(x) - Number(y)
        if (c) return c
    }
    return 0
}

function pack() {
    fs.rmSync(OUT, {recursive: true, force: true})
    fs.mkdirSync(OUT)
    for (const dir of craftDirs()) {
        execFileSync(CRAFTSMITH, ['pack', dir], {stdio: 'inherit'})
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.craft')))
            fs.renameSync(path.join(dir, f), path.join(OUT, f))
    }
    console.error(`→ ${fs.readdirSync(OUT).length} package(s) in out/`)
}

async function verify(where) {
    const index = await loadIndex(where)
    const {added, conflicts} = merge(index, readOut(), new Date().toISOString())
    for (const c of conflicts) console.error(`error: ${c}`)
    if (conflicts.length) process.exit(1)
    console.error(
        added.length
            ? `would publish: ${added.map((a) => a.url).join(', ')}`
            : 'nothing new to publish'
    )
}

async function publish(site) {
    const indexPath = path.join(site, 'index.json')
    const index = await loadIndex(indexPath)
    const {added, conflicts} = merge(index, readOut(), new Date().toISOString())
    for (const c of conflicts) console.error(`error: ${c}`)
    if (conflicts.length) process.exit(1)
    for (const a of added) {
        const dest = path.join(site, a.url)
        fs.mkdirSync(path.dirname(dest), {recursive: true})
        fs.writeFileSync(dest, a.bytes)
    }
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
    // Pages would otherwise run the site through Jekyll.
    fs.writeFileSync(path.join(site, '.nojekyll'), '')
    console.error(
        added.length
            ? `published: ${added.map((a) => a.url).join(', ')}`
            : 'nothing new to publish'
    )
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'pack') pack()
else if (cmd === 'verify' && arg) await verify(arg)
else if (cmd === 'publish' && arg) await publish(arg)
else {
    console.error(
        'usage: registry.mjs pack | verify <index.json URL or path> | publish <site dir>'
    )
    process.exit(1)
}
