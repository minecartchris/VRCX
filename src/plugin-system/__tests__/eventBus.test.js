import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EventBus } from '../eventBus';

describe('EventBus', () => {
    /** @type {EventBus} */
    let bus;

    beforeEach(() => {
        bus = new EventBus();
    });

    test('delivers payloads to subscribers', () => {
        const handler = vi.fn();
        bus.on('ping', handler);
        bus.emit('ping', { value: 1 });
        expect(handler).toHaveBeenCalledWith({ value: 1 });
    });

    test('unsubscribes via the returned function', () => {
        const handler = vi.fn();
        const off = bus.on('ping', handler);
        off();
        bus.emit('ping');
        expect(handler).not.toHaveBeenCalled();
        expect(bus.listenerCount('ping')).toBe(0);
    });

    test('a throwing handler does not stop the others', () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const second = vi.fn();
        bus.on('ping', () => {
            throw new Error('boom');
        });
        bus.on('ping', second);

        bus.emit('ping');

        expect(second).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    test('handlers removed during emit are not invoked', () => {
        const second = vi.fn();
        const off = bus.on('ping', second);
        bus.on('ping', () => off());
        // Registration order matters: the remover runs second here, so `second`
        // has already fired once and must not fire on the next emit.
        bus.emit('ping');
        bus.emit('ping');
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('rejects non function handlers', () => {
        expect(() => bus.on('ping', 'nope')).toThrow(TypeError);
    });

    test('emitting an event with no listeners is a no-op', () => {
        expect(() => bus.emit('nothing', {})).not.toThrow();
    });
});
