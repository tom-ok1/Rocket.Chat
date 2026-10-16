import type { OverlayTriggerState } from '@react-stately/overlays';
import { useStableCallback } from '@rocket.chat/fuselage-hooks';
import type { KeyboardEvent } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';

import { getActiveDescendantOptionProps, useActiveDescendant } from '../../../hooks/useActiveDescendant';

type SearchActiveOptionContextValue = {
	activeId: string | undefined;
	focusVisible: boolean;
	activate: (id: string) => void;
};

export const SearchActiveOptionContext = createContext<SearchActiveOptionContextValue>({
	activeId: undefined,
	focusVisible: false,
	activate: () => undefined,
});

/**
 * Keeps DOM focus on the search combobox and points it at the active option: no option is active until an arrow key
 * picks one, and typing clears it.
 */
export const useSearchActiveOption = (state: OverlayTriggerState, listboxId: string | undefined) => {
	const { active: activeId, setActive, focusVisible, setFocusVisible, moveByKeyboard, moveByPointer } = useActiveDescendant<string>();

	useEffect(() => {
		if (!state.isOpen) {
			setActive(undefined);
		}
	}, [state.isOpen, setActive]);

	const move = (step: 1 | -1) => {
		const options = Array.from(document.getElementById(listboxId ?? '')?.querySelectorAll<HTMLElement>('[role="option"][id]') ?? []);
		if (!options.length) {
			return;
		}

		const index = options.findIndex((option) => option.id === activeId);
		const start = step === 1 ? -1 : options.length;
		const next = options[((index === -1 ? start : index) + step + options.length) % options.length];

		next.scrollIntoView({ block: 'nearest' });
		moveByKeyboard(next.id);
	};

	const handleKeyDown = useStableCallback((event: KeyboardEvent) => {
		state.setOpen(true);

		if (event.code === 'Tab' || event.key === 'Escape') {
			state.close();
			return;
		}

		if (event.code === 'ArrowDown' || event.code === 'ArrowUp') {
			event.preventDefault();
			move(event.code === 'ArrowDown' ? 1 : -1);
			return;
		}

		if (event.key === 'Enter' && activeId) {
			const option = document.getElementById(activeId);
			if (option) {
				event.preventDefault();
				option.click();
			}
		}
	});

	const handleInput = useStableCallback(() => {
		setActive(undefined);
		setFocusVisible(true);
	});

	const contextValue = useMemo(() => ({ activeId, focusVisible, activate: moveByPointer }), [activeId, focusVisible, moveByPointer]);

	return {
		activeId: state.isOpen ? activeId : undefined,
		handleKeyDown,
		handleInput,
		contextValue,
	};
};

/**
 * Props that render a search option as the active one when the combobox points at it.
 */
export const useSearchOptionProps = (id: string | undefined) => {
	const { activeId, focusVisible, activate } = useContext(SearchActiveOptionContext);

	return {
		id,
		...getActiveDescendantOptionProps(!!id && id === activeId, focusVisible, () => id && activate(id)),
	};
};
