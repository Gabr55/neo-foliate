// Sets the app version everywhere it is declared: node scripts/set-version.mjs 1.2.3
import fs from 'node:fs'

const version = process.argv[2]?.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error(`Invalid version "${process.argv[2]}", expected X.Y.Z`)
    process.exit(1)
}

const updateJSON = (path, f) => {
    const json = JSON.parse(fs.readFileSync(path, 'utf8'))
    f(json)
    fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}

updateJSON('package.json', json => json.version = version)
updateJSON('src-tauri/tauri.conf.json', json => json.version = version)

const cargoPath = 'src-tauri/Cargo.toml'
const cargo = fs.readFileSync(cargoPath, 'utf8')
fs.writeFileSync(cargoPath, cargo.replace(/^version = ".*"$/m, `version = "${version}"`))

console.log(`Version set to ${version}`)
