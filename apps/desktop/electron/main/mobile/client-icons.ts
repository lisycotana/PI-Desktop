import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircleAlert,
  IconClose,
  IconDiff,
  IconEye,
  IconEyeOff,
  IconMore,
  IconSidebar,
  IconTerminal,
  IconPencil,
  IconFileText,
  IconFolder,
  IconSparkles,
  IconCamera,
  IconNewSession,
  IconWrench,
  IconLogOut,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStop,
  IconUndo2,
} from "../../../src/components/icons.tsx";

type IconComponent = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const icons: Record<string, IconComponent> = {
  arrowDown: IconArrowDown,
  arrowUp: IconArrowUp,
  bot: IconBot,
  check: IconCheck,
  chevronDown: IconChevronDown,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  circleAlert: IconCircleAlert,
  close: IconClose,
  diff: IconDiff,
  eye: IconEye,
  eyeOff: IconEyeOff,
  menu: IconSidebar,
  more: IconMore,
  panel: IconSidebar,
  terminal: IconTerminal,
  pencil: IconPencil,
  file: IconFileText,
  folder: IconFolder,
  sparkles: IconSparkles,
  camera: IconCamera,
  newTask: IconNewSession,
  wrench: IconWrench,
  logout: IconLogOut,
  plus: IconPlus,
  refresh: IconRefresh,
  search: IconSearch,
  stop: IconStop,
  undo: IconUndo2,
};

export function mobileIcon(name: keyof typeof icons, size = 16, className?: string): string {
  const Component = icons[name];
  return renderToStaticMarkup(
    createElement(Component, { size, className, "aria-hidden": true }),
  );
}

export const mobileIcons = Object.fromEntries(Object.keys(icons).map(name => [name, mobileIcon(name)]));
