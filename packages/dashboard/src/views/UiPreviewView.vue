<script setup lang="ts">
/**
 * Every @mushin/ui component in its states, for checking both themes at a glance. Development
 * builds only, at /dev/ui (registered in main.ts).
 */
import {
  Alert, Button, Card, Checkbox, Dropdown, Empty, Form, FormItem, Image, Input, Modal, NumberInput, Popover, RadioButton, RadioGroup, Select, Spin,
  TabPane, Tabs, Tag, TagsInput, Toggle, Tooltip, useConfirm, useToast,
} from '@mushin/ui'
import { ref } from 'vue'
import { themeMode } from '../theme'

const toast = useToast()
const confirm = useConfirm()

const on = ref(true)
const off = ref(false)
const text = ref('Hello')
const area = ref('A longer text\nover two lines')
const number = ref<number | null>(3)
const checked = ref(true)
const mode = ref('chat')
const single = ref<string | null>('deepseek-chat')
const many = ref<string[]>(['alpha', 'beta', 'gamma'])
const free = ref<string | null>(null)
const tags = ref(['hello', 'hi there'])
const tab = ref('settings')
const modal = ref(false)

const models = [
  { type: 'group' as const, key: 'DeepSeek', label: 'DeepSeek', children: [{ label: 'deepseek-chat', value: 'deepseek-chat' }, { label: 'deepseek-reasoner', value: 'deepseek-reasoner', description: 'thinks first' }] },
  { type: 'group' as const, key: 'OpenAI', label: 'OpenAI', children: [{ label: 'gpt-5.1', value: 'gpt-5.1' }, { label: 'gpt-5.1-mini', value: 'gpt-5.1-mini', disabled: true }] },
]
const bots = ['alpha', 'beta', 'gamma', 'delta'].map((value) => ({ label: value[0].toUpperCase() + value.slice(1), value }))
const menu = [
  { key: 'rename', label: 'Rename', icon: 'i-lucide-pencil' },
  { key: 'copy', label: 'Duplicate', icon: 'i-lucide-copy', description: 'With its settings' },
  { type: 'divider' as const },
  { key: 'delete', label: 'Delete', icon: 'i-lucide-trash-2', danger: true },
]
function askDelete() {
  confirm.warning({
    title: 'Delete Greeter?',
    content: 'The flow and its run history are removed.',
    positiveText: 'Delete',
    onPositiveClick: () => new Promise((resolve) => setTimeout(resolve, 600)),
  })
}
const tones = ['default', 'primary', 'info', 'success', 'warning', 'error'] as const
</script>

<template>
  <div class="mx-auto max-w-5xl p-6 flex flex-col gap-5 text-fg">
    <header class="flex items-center gap-3">
      <h1 class="m-0 text-xl font-semibold flex-1">@mushin/ui</h1>
      <RadioGroup v-model:value="themeMode" size="small" :options="[{ label: 'Light', value: 'light', icon: 'i-lucide-sun' }, { label: 'Dark', value: 'dark', icon: 'i-lucide-moon' }, { label: 'Auto', value: 'auto' }]" />
    </header>

    <Card title="Buttons">
      <div class="flex flex-col gap-3">
        <div v-for="tone in tones" :key="tone" class="flex flex-wrap items-center gap-2">
          <Button :type="tone">{{ tone }}</Button>
          <Button :type="tone" secondary>Secondary</Button>
          <Button :type="tone" tertiary>Tertiary</Button>
          <Button :type="tone" quaternary>Quaternary</Button>
          <Button :type="tone" dashed icon="i-lucide-plus">Dashed</Button>
          <Button :type="tone" text>Text</Button>
          <Button :type="tone" size="small" icon="i-lucide-save">Small</Button>
          <Button :type="tone" size="tiny">Tiny</Button>
          <Button :type="tone" circle quaternary icon="i-lucide-trash-2" aria-label="Delete" />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button type="primary" loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button quaternary circle size="small" icon="i-lucide-ban" :pressed="on" @click="on = !on" />
          <Button tertiary size="small" icon="i-lucide-funnel" :pressed="off" @click="off = !off">Filter</Button>
        </div>
      </div>
    </Card>

    <Card title="Toggles">
      <div class="flex flex-wrap items-center gap-4">
        <Toggle v-model:value="on" />
        <Toggle v-model:value="off" size="small" />
        <Toggle v-model:value="on" size="tiny" />
        <Toggle v-model:value="on" variant="button" />
        <Toggle v-model:value="off" variant="button" size="small" />
        <Toggle :value="true" variant="button" loading />
        <Toggle :value="false" disabled />
      </div>
    </Card>

    <div class="grid gap-5 md:grid-cols-2">
      <Card title="Form">
        <Form>
          <FormItem label="Name" required info="Shown in lists and logs.">
            <Input v-model:value="text" clearable placeholder="A short name" />
          </FormItem>
          <FormItem label="Prompt" feedback="What the model is told before the chat.">
            <Input v-model:value="area" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" />
          </FormItem>
          <FormItem label="Retries">
            <NumberInput v-model:value="number" :min="0" :max="9" clearable />
          </FormItem>
          <FormItem label="Mode">
            <RadioGroup v-model:value="mode">
              <RadioButton value="chat">Chat</RadioButton>
              <RadioButton value="classify">Classify</RadioButton>
              <RadioButton value="extract">Extract</RadioButton>
            </RadioGroup>
          </FormItem>
          <FormItem label="Quote the message">
            <Toggle v-model:value="checked" />
          </FormItem>
          <FormItem bare>
            <Checkbox v-model:checked="checked">Only in groups</Checkbox>
          </FormItem>
          <FormItem label="API key" validation-status="error" feedback="The key was refused.">
            <Input value="sk-123" type="password" show-password-on="click" status="error" />
          </FormItem>
        </Form>
      </Card>

      <Card title="Choices">
        <Form>
          <FormItem label="Model (groups, filterable)">
            <Select v-model:value="single" :options="models" filterable clearable />
          </FormItem>
          <FormItem label="Bots (multiple)">
            <Select v-model:value="many" :options="bots" multiple clearable placeholder="Every bot" />
          </FormItem>
          <FormItem label="Free text (tag)">
            <Select v-model:value="free" :options="bots" filterable tag clearable placeholder="Pick or type" />
          </FormItem>
          <FormItem label="Keywords">
            <TagsInput v-model:value="tags" />
          </FormItem>
          <FormItem label="Small">
            <div class="flex gap-2">
              <Select v-model:value="mode" class="flex-1" size="small" :options="[{ label: 'Chat', value: 'chat' }, { label: 'Classify', value: 'classify' }]" />
              <Input v-model:value="text" class="flex-1" size="small" />
              <NumberInput v-model:value="number" class="w-28" size="small" />
            </div>
          </FormItem>
          <FormItem label="Disabled">
            <Select :value="'chat'" disabled :options="[{ label: 'Chat', value: 'chat' }]" />
          </FormItem>
        </Form>
      </Card>
    </div>

    <Card title="Tags and notes">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-2">
          <Tag v-for="tone in tones" :key="tone" :type="tone">{{ tone }}</Tag>
          <Tag type="primary" round icon="i-lucide-bot">round</Tag>
          <Tag closable>closable</Tag>
          <Tag type="warning" bordered size="small">bordered</Tag>
        </div>
        <Alert v-for="tone in ['info', 'success', 'warning', 'error'] as const" :key="tone" :type="tone" :title="tone === 'info' ? 'With a title' : undefined" closable>
          A note of type {{ tone }}, which can run long enough to wrap onto a second line in a narrow panel.
        </Alert>
      </div>
    </Card>

    <div class="grid gap-5 md:grid-cols-2">
      <Card title="Tabs">
        <Tabs v-model:value="tab" type="segment" size="small">
          <TabPane name="settings" tab="Settings">Settings content</TabPane>
          <TabPane name="io" tab="Inputs and outputs">Wiring content</TabPane>
        </Tabs>
        <Tabs class="mt-4" default-value="node" justify="stretch">
          <TabPane name="node" tab="Node">Node</TabPane>
          <TabPane name="flow" tab="Flow">Flow</TabPane>
        </Tabs>
      </Card>

      <Card title="Overlays">
        <template #header-extra><Tag size="small">header-extra</Tag></template>
        <div class="flex flex-wrap items-center gap-2">
          <Tooltip>
            <template #trigger><Button size="small" icon="i-lucide-info">Tooltip</Button></template>
            A hint that explains the button.
          </Tooltip>
          <Popover>
            <template #trigger><Button size="small">Popover</Button></template>
            <div class="text-sm text-fg2 w-56">Anything can go in here, such as a small form.</div>
          </Popover>
          <Dropdown :options="menu" @select="(key: string) => toast.info(`Chose ${key}`)">
            <Button size="small" icon="i-lucide-ellipsis" icon-placement="right">Menu</Button>
          </Dropdown>
          <Button size="small" @click="modal = true">Modal</Button>
          <Button size="small" @click="toast.success('Saved')">Toast</Button>
          <Button size="small" @click="toast.error('Could not reach the server')">Error toast</Button>
          <Button size="small" type="error" secondary @click="askDelete">Confirm</Button>
        </div>
        <div class="mt-4 flex items-center gap-6">
          <Spin size="small" />
          <Spin :show="true" description="Loading"><div class="h-16 w-40 rounded bg-s2" /></Spin>
          <Empty size="small" description="No flows yet" />
          <Image src="/logo.png" alt="Logo" class="h-16 w-16 rounded" />
        </div>
      </Card>
    </div>

    <Modal v-model:show="modal" title="Rename flow">
      <Form>
        <FormItem label="Name"><Input v-model:value="text" /></FormItem>
      </Form>
      <template #footer>
        <Button @click="modal = false">Cancel</Button>
        <Button type="primary" @click="modal = false">Save</Button>
      </template>
    </Modal>
  </div>
</template>
