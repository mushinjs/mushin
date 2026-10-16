import { describe, expect, it } from 'vitest'
import { Actions, Context, fromToolName, isMasked, mask, messageType, MushinError, toToolName, z } from '../src'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(Actions)
  return ctx
}

describe('actions', () => {
  it('validates input and runs the handler', async () => {
    const ctx = await setup()
    ctx.actions.define({
      name: 'math.add',
      description: 'Add two numbers',
      risk: 'read',
      input: z.object({ a: z.number(), b: z.number().default(1) }),
      handler: ({ a, b }) => a + b,
    })
    expect(await ctx.actions.call('math.add', { a: 2 })).toBe(3)
    await expect(ctx.actions.call('math.add', { a: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.actions.call('math.nope', {})).rejects.toBeInstanceOf(MushinError)
  })

  it('exposes JSON Schemas and removes actions when the plugin unloads', async () => {
    const ctx = await setup()
    const fiber = ctx.plugin({
      name: 'demo',
      inject: ['actions'],
      apply(ctx: Context) {
        ctx.actions.define({
          name: 'demo.greet',
          description: 'Greet someone',
          risk: 'write',
          input: z.object({ who: z.string().describe('Name') }),
          handler: ({ who }) => `hi ${who}`,
        })
      },
    })
    await fiber
    const info = ctx.actions.get('demo.greet')!
    expect(info.plugin).toBe('demo')
    expect(info.inputSchema).toMatchObject({ type: 'object', properties: { who: { type: 'string', description: 'Name' } } })
    await fiber.dispose()
    expect(ctx.actions.has('demo.greet')).toBe(false)
  })

  it('rejects names that are not dotted', async () => {
    const ctx = await setup()
    expect(() => ctx.actions.define({ name: 'flat', description: '', risk: 'read', input: z.object({}), handler: () => 1 })).toThrow()
  })

  it('relays client actions only while a relay is set', async () => {
    const ctx = await setup()
    ctx.actions.define({ name: 'ui.navigate', description: '', risk: 'read', client: true, input: z.object({ path: z.string() }) })
    await expect(ctx.actions.call('ui.navigate', { path: '/' })).rejects.toMatchObject({ code: 'unavailable' })
    ctx.actions.setClientRelay(async (name, input) => ({ name, input }))
    expect(await ctx.actions.call('ui.navigate', { path: '/bots' })).toEqual({ name: 'ui.navigate', input: { path: '/bots' } })
  })
})

describe('helpers', () => {
  it('maps action names to tool names and back', () => {
    expect(toToolName('bots.plugins.enable')).toBe('bots__plugins__enable')
    expect(fromToolName('bots__plugins__enable')).toBe('bots.plugins.enable')
  })

  it('masks secrets recognizably', () => {
    expect(mask('sk-abcdef123456')).toBe('sk-…3456')
    expect(isMasked(mask('sk-abcdef123456'))).toBe(true)
    expect(isMasked('sk-abcdef123456')).toBe(false)
  })

  it('derives the message type from segments', () => {
    expect(messageType([{ type: 'at', data: {} }, { type: 'text', data: { text: 'hi' } }])).toBe('text')
    expect(messageType([{ type: 'image', data: {} }])).toBe('image')
    expect(messageType([{ type: 'text', data: {} }, { type: 'image', data: {} }])).toBe('mixed')
    expect(messageType([{ type: 'record', data: {} }])).toBe('voice')
  })
})
