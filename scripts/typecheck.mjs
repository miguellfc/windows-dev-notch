// Runs both tsc projects and reports each one, so a failure in the first never hides the second.
import { spawnSync } from 'node:child_process'

const projects = ['tsconfig.node.json', 'tsconfig.web.json']
const failed = projects.filter((project) => {
  console.log(`\n> tsc --noEmit -p ${project}`)
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', project], { stdio: 'inherit' })
  return result.status !== 0
})

if (failed.length > 0) {
  console.error(`\nTypecheck failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log('\nTypecheck passed: ' + projects.join(', '))
