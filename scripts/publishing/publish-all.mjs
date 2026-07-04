// Publish Chrome then Firefox in sequence (each script builds its own fresh
// production artifact first). Ctrl+C kills the current child and aborts.
// Ported from reveddit's publish-all.js (minus Edge — GhostedWatch isn't
// listed there).
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { c } from './common.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const steps = [
    ['node', [path.join(__dirname, 'publish-chrome.mjs')]],
    ['node', [path.join(__dirname, 'publish-firefox.mjs')]],
]

let current = null
let aborted = false
process.on('SIGINT', () => {
    console.log('\n' + c.red('✖ Publishing aborted by user'))
    aborted = true
    current?.kill('SIGINT')
    process.exit(130)
})

const run = ([cmd, args]) =>
    new Promise((resolve, reject) => {
        current = spawn(cmd, args, { stdio: 'inherit', cwd: process.cwd() })
        current.on('close', code => {
            current = null
            code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
        })
        current.on('error', err => {
            current = null
            reject(err)
        })
    })

console.log(c.cyan('🚀 Publish all: Chrome → Firefox (each builds fresh prod)\n'))
for (const step of steps) {
    if (aborted) break
    try {
        await run(step)
    } catch (error) {
        if (!aborted) {
            console.error(c.red(`Failed: ${error.message}`))
            process.exit(1)
        }
        break
    }
}
if (!aborted) console.log('\n' + c.green('✔ All stores published!'))
