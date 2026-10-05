<template>
    <div class="flex flex-col gap-1.5">
        <div class="flex items-start justify-between gap-6">
            <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                <span class="text-sm leading-snug text-foreground">{{ label }}</span>
                <span v-if="description" class="text-xs leading-tight text-muted-foreground">{{ description }}</span>
            </div>

            <div class="flex items-center gap-2 shrink-0">
                <Switch
                    v-if="field.type === 'boolean'"
                    :model-value="modelValue"
                    :aria-label="label"
                    @update:modelValue="emit('update:modelValue', $event)" />

                <NumberField
                    v-else-if="field.type === 'number'"
                    class="w-36"
                    :model-value="Number(modelValue) || 0"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step ?? 1"
                    @update:modelValue="emit('update:modelValue', $event ?? 0)">
                    <NumberFieldContent>
                        <NumberFieldDecrement />
                        <NumberFieldInput :aria-label="label" />
                        <NumberFieldIncrement />
                    </NumberFieldContent>
                </NumberField>

                <Select
                    v-else-if="field.type === 'select'"
                    :model-value="modelValue"
                    @update:modelValue="emit('update:modelValue', $event)">
                    <SelectTrigger size="sm" class="min-w-[180px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="option in field.options" :key="String(option.value)" :value="option.value">
                            {{ option.label }}
                        </SelectItem>
                    </SelectContent>
                </Select>

                <Input
                    v-else-if="field.type === 'string' || field.type === 'password'"
                    class="w-64"
                    :type="field.type === 'password' ? 'password' : 'text'"
                    :model-value="modelValue"
                    :placeholder="field.placeholder"
                    :aria-label="label"
                    @update:modelValue="emit('update:modelValue', $event)" />
            </div>
        </div>

        <Textarea
            v-if="field.type === 'text'"
            class="min-h-20"
            :model-value="modelValue"
            :placeholder="field.placeholder"
            :aria-label="label"
            @update:modelValue="emit('update:modelValue', $event)" />

        <TagsInput
            v-else-if="field.type === 'list'"
            :model-value="listValue"
            add-on-blur
            :aria-label="label"
            @update:modelValue="emit('update:modelValue', $event)">
            <TagsInputItem v-for="item in listValue" :key="item" :value="item">
                <TagsInputItemText />
                <TagsInputItemDelete />
            </TagsInputItem>
            <TagsInputInput :placeholder="field.placeholder || t('view.plugins.field.add_entry')" />
        </TagsInput>

        <div v-else-if="field.type === 'multiselect'" class="flex flex-wrap gap-2">
            <label
                v-for="option in field.options"
                :key="String(option.value)"
                class="flex items-center gap-1.5 text-xs cursor-pointer rounded-md border px-2 py-1">
                <Checkbox
                    :model-value="listValue.includes(option.value)"
                    @update:modelValue="toggleMultiselect(option.value, $event)" />
                <span>{{ option.label }}</span>
            </label>
        </div>
    </div>
</template>

<script setup>
    import { computed } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Checkbox } from '@/components/ui/checkbox';
    import { Input } from '@/components/ui/input';
    import {
        NumberField,
        NumberFieldContent,
        NumberFieldDecrement,
        NumberFieldIncrement,
        NumberFieldInput
    } from '@/components/ui/number-field';
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
    import { Switch } from '@/components/ui/switch';
    import {
        TagsInput,
        TagsInputInput,
        TagsInputItem,
        TagsInputItemDelete,
        TagsInputItemText
    } from '@/components/ui/tags-input';
    import { Textarea } from '@/components/ui/textarea';

    const props = defineProps({
        field: { type: Object, required: true },
        modelValue: { type: null, default: null }
    });
    const emit = defineEmits(['update:modelValue']);

    const { t, te } = useI18n();

    const label = computed(() => {
        if (props.field.labelKey && te(props.field.labelKey)) {
            return t(props.field.labelKey);
        }
        return props.field.label ?? props.field.key;
    });

    const description = computed(() => {
        if (props.field.descriptionKey && te(props.field.descriptionKey)) {
            return t(props.field.descriptionKey);
        }
        return props.field.description ?? '';
    });

    const listValue = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

    function toggleMultiselect(value, checked) {
        const next = listValue.value.filter((item) => item !== value);
        if (checked) {
            next.push(value);
        }
        emit('update:modelValue', next);
    }
</script>
