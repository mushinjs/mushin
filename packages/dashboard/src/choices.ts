import { reactive } from 'vue'
import { call, on } from './api'

export interface Choice {
  value: string
  label: string
}

/**
 * Values a text field can take, read from the action its schema names in `x-choices` (see
 * `field()` in @mushin/core). Loaded once per action and kept fresh when plugins change.
 */
const lists = reactive<Record<string, Choice[]>>({})
const loading = new Map<string, Promise<void>>()

export function loadChoices(action: string, force = false) {
  if (!force && loading.has(action)) return loading.get(action)!
  const promise = call<Choice[]>(action).then((list) => {
    lists[action] = list
  }, () => {
    lists[action] ??= []
  })
  loading.set(action, promise)
  return promise
}

/** The choices of an action, loading them the first time. Reactive. */
export function choicesOf(action: string) {
  if (!loading.has(action)) void loadChoices(action)
  return lists[action] ?? []
}

/** A value's label, when its list is loaded. */
export function choiceLabel(action: string, value: string) {
  return choicesOf(action).find((choice) => choice.value === value)?.label
}

/** Reloads every list, e.g. after personas change. */
export function refreshChoices() {
  for (const action of Object.keys(lists)) void loadChoices(action, true)
}

on('manager/changed', refreshChoices)
on('personas/changed', refreshChoices)
on('knowledge/changed', refreshChoices)
// Flow tables and their fields are choices of the database nodes.
on('flows/changed', refreshChoices)
