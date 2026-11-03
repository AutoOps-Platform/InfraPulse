import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';

export const getStyles = (t: GrafanaTheme2) => ({
  root: css`
    padding-bottom: ${t.spacing(4)};
    min-width: 0;
  `,
  nav: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${t.spacing(1)};
    margin-bottom: ${t.spacing(3)};
    a {
      padding: ${t.spacing(1)};
      border-bottom: 2px solid transparent;
    }
    a[aria-current='page'] {
      border-color: ${t.colors.primary.main};
    }
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: ${t.spacing(2)};
    margin: ${t.spacing(2)} 0;
    > * {
      min-width: 0;
    }
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
    gap: ${t.spacing(2)};
    margin: ${t.spacing(2)} 0;
  `,
  card: css`
    background: ${t.colors.background.secondary};
    border: 1px solid ${t.colors.border.weak};
    border-radius: ${t.shape.radius.default};
    padding: ${t.spacing(2)};
    min-width: 0;
    overflow-wrap: anywhere;
  `,
  table: css`
    overflow-x: auto;
    margin: ${t.spacing(2)} 0;
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th,
    td {
      text-align: left;
      vertical-align: top;
      padding: ${t.spacing(1.5)};
      border-bottom: 1px solid ${t.colors.border.weak};
    }
    th {
      color: ${t.colors.text.secondary};
    }
    caption {
      text-align: left;
      padding: ${t.spacing(1)} 0;
    }
  `,
  code: css`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    padding: ${t.spacing(2)};
    background: ${t.colors.background.primary};
    border: 1px solid ${t.colors.border.weak};
    max-height: 400px;
    overflow: auto;
  `,
  muted: css`
    color: ${t.colors.text.secondary};
  `,
  form: css`
    max-width: 760px;
    display: grid;
    gap: ${t.spacing(1)};
  `,
});
