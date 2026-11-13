export { cn } from "cn"

/**
 * For Astryx table columns: sizes the column to its content so spare width goes
 * to the main column. Astryx cells default to max-width: 0 (for truncation),
 * which makes `w-*` classes no-ops and splits spare width evenly.
 */
export const fitColumn = 'w-px whitespace-nowrap max-w-none'
