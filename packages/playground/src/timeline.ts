let sequence = 0;
/** Break same-millisecond ties across messages, tools, proposals and analysis cards. */
export const timelineOrder = () => ++sequence;
