import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { resolve } from 'path'

class Worker {
  private process: ChildProcess

  constructor() {}

  start() {
    this.process = spawn('vite', ['preview'], {
      cwd: resolve(require.resolve('@mushinjs/console')),
      stdio: 'inherit',
    }) as ChildProcess

    this.process.on('exit', (code) => {
      console.log(`Worker process exited with code ${code}`)
    })
  }

  stop() {
    console.log('Stopping worker')
    this.process.kill()
  }
}

const worker = new Worker()
worker.start()

process.on('SIGINT', () => {
  worker.stop()
  process.exit()
})
