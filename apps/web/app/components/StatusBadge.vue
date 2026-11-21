<template>
  <span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="tone">
    <component :is="icon" :size="13" weight="bold" aria-hidden="true" />{{ STATUS_LABEL[status] ?? status }}
  </span>
</template>

<script setup lang="ts">
import { PhCheckCircle, PhCircle, PhInfo, PhProhibit, PhWarning, PhXCircle } from '@phosphor-icons/vue';

const props = defineProps<{ status: string }>();
const GOOD = ['published', 'processed', 'resolved', 'matched', 'calculated', 'complete', 'valid', 'approved'];
const WARN = ['warning', 'ready_for_review', 'accepted', 'accepted_difference', 'incomplete', 'processing', 'validating'];
const BAD = ['blocked', 'failed', 'critical', 'mismatch', 'unmatched', 'not_calculable', 'invalid'];
const MUTED = ['superseded', 'excluded', 'draft', 'informational'];
const tone = computed(() => GOOD.includes(props.status) ? 'bg-success-bg text-success'
  : BAD.includes(props.status) ? 'bg-critical-bg text-critical'
    : WARN.includes(props.status) ? 'bg-warning-bg text-warning'
      : MUTED.includes(props.status) ? 'bg-info-bg text-muted' : 'bg-info-bg text-ink');
const icon = computed(() => GOOD.includes(props.status) ? PhCheckCircle : BAD.includes(props.status) ? PhXCircle
  : WARN.includes(props.status) ? PhWarning : props.status === 'excluded' ? PhProhibit : props.status === 'informational' ? PhInfo : PhCircle);
</script>
