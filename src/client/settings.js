function createLocalSettingsStore() {
	const listeners = new Set();
	let state = { ...DEFAULT_SETTINGS };
	return {
		getSnapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(field, value) {
			state = { ...state, [field]: value };
			for (const listener of [...listeners]) listener();
		},
		resetField() {},
		resetAll() {
			state = { ...DEFAULT_SETTINGS };
		},
		dispose() {},
	};
}

function createConfigFormStore() {
	return createLocalSettingsStore();
}

function createSettingsStore() {
	return createLocalSettingsStore();
}
