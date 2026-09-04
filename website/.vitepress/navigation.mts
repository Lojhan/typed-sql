import navigation from "./navigation.json" with { type: "json" };

interface NavigationItem {
  readonly text: string;
  readonly link: string;
}

interface NavigationSection {
  readonly text: string;
  readonly collapsed?: boolean;
  readonly items: readonly NavigationItem[];
}

const sections: readonly NavigationSection[] = navigation.sections;

export const documentationSidebar = sections.map(({ text, collapsed, items }) => ({
  text,
  ...(collapsed === undefined ? {} : { collapsed }),
  items: items.map(({ text: itemText, link }) => ({ text: itemText, link })),
}));

export const topNavigation: readonly NavigationItem[] = navigation.topNavigation;
