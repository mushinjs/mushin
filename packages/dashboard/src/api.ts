import { reactive } from 'vue'

const TOKEN_KEY = 'mushin.token'

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message)
  }
}

export const connection = reactive({
  token: readToken(),
  connected: false,
  clientId: '',
})

type Listener = (data: any) => void
const listeners = new Map<string, Set<Listener>>()

/** Subscribes to a server event such as `bots/status`; returns an unsubscribe function. */
export function on(name: string, listener: Listener) {
  let set = listeners.get(name)
  if (!set) listeners.set(name, set = new Set())
  set.add(listener)
  return () => set!.delete(listener)
}

function emit(name: string, data: unknown) {
  for (const listener of listeners.get(name) ?? []) {
    try {
      listener(data)
    } catch (error) {
      console.error(error)
    }
  }
}

type ClientHandler = (input: any) => unknown
const clientHandlers = new Map<string, ClientHandler>()

/** Handles a client action (e.g. `ui.navigate`) that the server relays from the Agent. */
export function handleClientAction(name: string, handler: ClientHandler) {
  clientHandlers.set(name, handler)
}

let socket: WebSocket | undefined
let reconnectTimer: number | undefined
let currentPage = location.pathname
let counter = 0
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()

function send(data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data))
}

export function connect() {
  if (!connection.token || socket) return
  window.clearTimeout(reconnectTimer)
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`)
  socket = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: connection.token, page: currentPage }))
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data)
    switch (message.type) {
      case 'ready':
        connection.connected = true
        connection.clientId = message.client
        emit('connected', null)
        break
      case 'event':
        emit(message.name, message.data)
        break
      case 'result': {
        const call = pending.get(message.id)
        if (!call) break
        pending.delete(message.id)
        if (message.ok) call.resolve(message.result)
        else call.reject(new ApiError(message.error.code, message.error.message, message.error.details))
        break
      }
      case 'client-call': {
        const handler = clientHandlers.get(message.action)
        try {
          if (!handler) throw new Error(`This dashboard cannot run ${message.action}`)
          const result = await handler(message.input)
          send({ type: 'client-result', id: message.id, ok: true, result: result ?? { ok: true } })
        } catch (error) {
          send({ type: 'client-result', id: message.id, ok: false, error: { message: String((error as Error)?.message ?? error) } })
        }
        break
      }
    }
  }
  ws.onclose = (event) => {
    if (socket !== ws) return
    socket = undefined
    connection.connected = false
    for (const call of pending.values()) call.reject(new ApiError('unavailable', 'Connection lost'))
    pending.clear()
    emit('disconnected', null)
    if (event.code === 4401) {
      logout('expired')
      return
    }
    if (connection.token) reconnectTimer = window.setTimeout(connect, 2000)
  }
}

/** Tells the server which page is open, so the Agent knows where the user is. */
export function setPage(path: string) {
  currentPage = path
  send({ type: 'page', path })
}

/** Runs an action. Uses the WebSocket when connected, so client actions route back to this tab. */
export async function call<T = any>(action: string, input: unknown = {}): Promise<T> {
  if (socket && connection.connected) {
    const id = String(++counter)
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ type: 'call', id, action, input })
    })
  }
  const response = await fetch(`/api/actions/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  let json: any
  try {
    json = await response.json()
  } catch {
    throw new ApiError('unavailable', `Mushin.js answered HTTP ${response.status}`)
  }
  if (response.status === 401) logout('expired')
  if (!json.ok) throw new ApiError(json.error.code, json.error.message, json.error.details)
  return json.result
}

export async function login(token: string) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) return false
  connection.token = token
  writeToken(token)
  connect()
  return true
}

/** Forgets the token. `expired` means the server rejected it, as opposed to the user signing out. */
export function logout(reason: 'user' | 'expired' = 'user') {
  if (!connection.token) return
  connection.token = ''
  writeToken('')
  window.clearTimeout(reconnectTimer)
  const ws = socket
  socket = undefined
  connection.connected = false
  ws?.close()
  emit('logout', reason)
}
