import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

describe('node tutorials', () => {
  it('runs every example the way its captions tell it', async () => {
    const types = await app.call<any[]>('flows.nodeTypes')
    const guided = types.filter((type) => type.guide?.example)
    expect(guided.length).toBeGreaterThan(15)
    for (const type of guided) {
      const run = await app.call<any>('flows.guide', { type: type.type })
      const context = `${type.type}: ${JSON.stringify(run)}`
      expect(run, context).toBeTruthy()
      expect(run.matched, context).toBe(true)
      expect(run.error, context).toBeUndefined()
      expect(run.steps.filter((step: any) => step.error), context).toEqual([])
      expect(run.steps.some((step: any) => run.nodes.find((node: any) => node.id === step.nodeId)?.type === type.type), context).toBe(true)
      if (type.guide.captions) {
        expect(type.guide.example.repeat ? run.passes.length : run.steps.length, context).toBe(type.guide.captions.length)
      }
      for (const pass of run.passes) expect(pass.steps.filter((step: any) => step.error), context).toEqual([])
    }
  })

  it('has nothing for a node without an example', async () => {
    expect(await app.call('flows.guide', { type: 'trigger.schedule' })).toBeNull()
  })
})
