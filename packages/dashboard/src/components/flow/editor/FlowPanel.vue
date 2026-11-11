<script setup lang="ts">
/** The inspector's flow tab: the description and every problem the flow has. */
import { Alert, Form, FormItem, Input } from '@mushinjs/ui'
import { RouterLink } from 'vue-router'
import { useEditor } from './editor'

const { t, description, allIssues: issues, nodeName, selectIssue } = useEditor()
</script>

<template>
  <Form label-placement="top" size="small">
    <FormItem :label="t('flows.description')">
      <Input v-model:value="description" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" />
    </FormItem>
  </Form>
  <h4 class="section">{{ t('flows.issues') }}</h4>
  <p v-if="!issues.length" class="muted">{{ t('flows.noIssues') }}</p>
  <Alert
    v-for="(issue, index) in issues"
    :key="index"
    :type="issue.severity"
    :show-icon="false"
    class="issue"
    :class="{ clickable: !!issue.nodeId }"
    @click="selectIssue(issue)"
  >
    <strong v-if="issue.nodeId">{{ nodeName(issue.nodeId) }}: </strong>{{ issue.message }}
    <RouterLink v-if="issue.plugin" :to="`/plugins?highlight=${issue.plugin}`" class="issue-link" @click.stop>{{ t('flows.enablePlugin') }}</RouterLink>
  </Alert>
  <p class="muted small">{{ t('flows.editHelp') }}</p>
</template>

<style scoped src="./panel.css"></style>
