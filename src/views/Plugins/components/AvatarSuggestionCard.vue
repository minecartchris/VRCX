<template>
    <div class="group relative">
        <button
            type="button"
            class="flex w-full flex-col gap-2 rounded-lg border bg-card p-2 text-left transition-colors hover:bg-accent cursor-pointer"
            @click="emit('click')">
            <div class="aspect-[4/3] w-full overflow-hidden rounded-md bg-muted">
                <img
                    v-if="thumbnail"
                    :src="thumbnail"
                    :alt="avatar.name || ''"
                    loading="lazy"
                    class="h-full w-full object-cover transition-transform group-hover:scale-105" />
                <div v-else class="flex h-full w-full items-center justify-center text-muted-foreground">
                    <i class="ri-user-3-line text-2xl" />
                </div>
            </div>
            <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-sm font-medium text-foreground">{{ avatar.name || avatar.id }}</span>
                <span v-if="caption" class="truncate text-xs text-muted-foreground">{{ caption }}</span>
            </div>
        </button>
        <!-- Outside the card's button, since buttons cannot nest -->
        <button
            v-if="hideLabel"
            type="button"
            class="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer"
            :title="hideLabel"
            :aria-label="hideLabel"
            @click="emit('hide')">
            <i class="ri-eye-off-line" />
        </button>
        <!-- A liked avatar keeps its heart visible; an unliked one reveals it
             on hover, like the hide button. -->
        <button
            v-if="likeLabel"
            type="button"
            class="absolute top-3 left-3 flex size-7 items-center justify-center rounded-md bg-background/80 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer"
            :class="liked ? 'text-destructive opacity-100' : 'text-muted-foreground opacity-0 hover:text-foreground'"
            :title="likeLabel"
            :aria-label="likeLabel"
            :aria-pressed="liked"
            @click="emit('like')">
            <i :class="liked ? 'ri-heart-fill' : 'ri-heart-line'" />
        </button>
    </div>
</template>

<script setup>
    import { computed } from 'vue';

    const props = defineProps({
        avatar: { type: Object, required: true },
        caption: { type: String, default: '' },
        /** Shows a hide button with this label when set. */
        hideLabel: { type: String, default: '' },
        /** Shows a like toggle with this label when set. */
        likeLabel: { type: String, default: '' },
        /** Current like state, for the toggle's appearance. */
        liked: { type: Boolean, default: false }
    });
    const emit = defineEmits(['click', 'hide', 'like']);

    const thumbnail = computed(() => props.avatar.thumbnailImageUrl || props.avatar.imageUrl || '');
</script>
