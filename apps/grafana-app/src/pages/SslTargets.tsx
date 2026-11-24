import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import type { GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  LinkButton,
  Modal,
  useStyles2,
} from '@grafana/ui';
import { api, errorMessage } from '../api/client';
import type { CreateSslTargetInput, SslTarget } from '../api/types';
import { sslDashboardHref } from '../api/vm-routes';
import { ActionState, LoadState, useAdmin } from '../components/Common';
import { Confirm } from '../components/Confirm';
import { useAction, useResource } from '../hooks/useApi';
import { getStyles } from '../styles';

const getSslStyles = (t: GrafanaTheme2) => ({
  header: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: ${t.spacing(2)};
    margin-bottom: ${t.spacing(2.5)};
  `,
  subtitle: css`
    color: ${t.colors.text.secondary};
    font-size: ${t.typography.bodySmall.fontSize};
    margin: 0;
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${t.spacing(1)};
  `,
  kpiGrid: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${t.spacing(2)};
    margin-bottom: ${t.spacing(2.5)};
    @media (max-width: 900px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  `,
  kpiCard: css`
    background: ${t.colors.background.secondary};
    border: 1px solid ${t.colors.border.weak};
    border-radius: ${t.shape.radius.default};
    padding: ${t.spacing(1.5, 2)};
    display: flex;
    flex-direction: column;
    gap: ${t.spacing(0.5)};
  `,
  kpiLabel: css`
    font-size: ${t.typography.bodySmall.fontSize};
    color: ${t.colors.text.secondary};
  `,
  kpiValue: css`
    font-size: 24px;
    font-weight: ${t.typography.fontWeightMedium};
    line-height: 1.2;
  `,
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: ${t.spacing(1.5)};
    margin-bottom: ${t.spacing(2)};
  `,
  searchWrap: css`
    width: 300px;
    max-width: 100%;
  `,
  groupPills: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${t.spacing(0.75)};
  `,
  pill: css`
    background: ${t.colors.background.secondary};
    border: 1px solid ${t.colors.border.weak};
    color: ${t.colors.text.secondary};
    border-radius: 999px;
    padding: 4px 12px;
    font-size: ${t.typography.bodySmall.fontSize};
    cursor: pointer;
    transition: all 0.15s ease;
    &:hover {
      border-color: ${t.colors.border.strong};
      color: ${t.colors.text.primary};
    }
  `,
  pillActive: css`
    background: ${t.colors.primary.transparent};
    border-color: ${t.colors.primary.border};
    color: ${t.colors.primary.text};
    font-weight: ${t.typography.fontWeightMedium};
  `,
  tableCard: css`
    background: ${t.colors.background.secondary};
    border: 1px solid ${t.colors.border.weak};
    border-radius: ${t.shape.radius.default};
    overflow: hidden;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    th,
    td {
      padding: ${t.spacing(1.5, 1.5)};
      border-bottom: 1px solid ${t.colors.border.weak};
      vertical-align: middle;
      text-align: left;
    }
    th {
      font-size: ${t.typography.bodySmall.fontSize};
      font-weight: ${t.typography.fontWeightMedium};
      color: ${t.colors.text.secondary};
      background: ${t.colors.background.primary};
      white-space: nowrap;
    }
    tbody tr:last-child td {
      border-bottom: none;
    }
    tbody tr:hover {
      background: ${t.colors.action.hover};
    }
  `,
  primaryText: css`
    font-weight: ${t.typography.fontWeightMedium};
    color: ${t.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  subText: css`
    font-size: ${t.typography.bodySmall.fontSize};
    color: ${t.colors.text.secondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  `,
  monoSub: css`
    font-family: ${t.typography.fontFamilyMonospace};
    font-size: 12px;
    color: ${t.colors.text.secondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  `,
  groupTag: css`
    display: inline-block;
    padding: 2px 8px;
    border-radius: ${t.shape.radius.default};
    background: ${t.colors.background.canvas};
    border: 1px solid ${t.colors.border.weak};
    font-size: 12px;
    color: ${t.colors.text.secondary};
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  rowActions: css`
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${t.spacing(1)};
    white-space: nowrap;
  `,
  badgeCell: css`
    white-space: nowrap;
  `,
  rightCol: css`
    text-align: right !important;
  `,
});

function parseEndpointInput(raw: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Vui lòng nhập domain hoặc URL HTTPS.');
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Domain hoặc URL không hợp lệ (ví dụ: infrapulse.hacmieu.com hoặc https://example.com:8443).');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const port = parsed.port ? Number(parsed.port) : fallbackPort;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Host hoặc cổng (1–65535) không hợp lệ.');
  }
  return { host, port };
}

function daysRemaining(notAfter: string | null): number | null {
  if (!notAfter) return null;
  const ms = Date.parse(notAfter);
  if (!Number.isFinite(ms)) return null;
  return (ms - Date.now()) / 86_400_000;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Chưa kiểm tra';
  const diffSec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  return `${Math.floor(diffSec / 86400)} ngày trước`;
}

function StatusBadge({ target }: { target: SslTarget }) {
  if (!target.enabled) {
    return <Badge text="Đã tắt" color="blue" />;
  }
  const days = daysRemaining(target.notAfter);
  if (days === null) {
    return <Badge text={target.lastError ? 'Lỗi kết nối' : 'Đang chờ'} color={target.lastError ? 'red' : 'blue'} />;
  }
  if (days < 0) {
    return <Badge text={`Hết hạn (${Math.abs(Math.round(days))}d)`} color="red" />;
  }
  if (days < 7) {
    return <Badge text={`Còn ${days.toFixed(1)} ngày`} color="red" />;
  }
  if (days < 28) {
    return <Badge text={`Còn ${Math.round(days)} ngày`} color="orange" />;
  }
  return <Badge text={`Còn ${Math.round(days)} ngày`} color="green" />;
}

function AddSslTargetModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [endpoint, setEndpoint] = useState('');
  const [name, setName] = useState('');
  const [portText, setPortText] = useState('443');
  const [group, setGroup] = useState('Production');
  const [validation, setValidation] = useState<string>();
  const action = useAction();
  const s = useStyles2(getStyles);

  const submit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.pending) return;
    setValidation(undefined);
    let payload: CreateSslTargetInput;
    try {
      const parsedPort = Number(portText.trim() || '443');
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error('Port phải là số nguyên từ 1 đến 65535.');
      }
      const { host, port } = parseEndpointInput(endpoint, parsedPort);
      const finalName = name.trim() || host;
      const finalGroup = group.trim() || 'default';
      payload = { name: finalName, host, port, group: finalGroup, enabled: true };
    } catch (err: unknown) {
      setValidation(err instanceof Error ? err.message : 'Dữ liệu không hợp lệ.');
      return;
    }
    void action.run(
      () => api.createSslTarget(payload),
      () => {
        onSaved();
        onClose();
      }
    );
  };

  return (
    <Modal
      title="Thêm chứng chỉ SSL bên ngoài"
      isOpen
      onDismiss={() => {
        if (!action.pending) onClose();
      }}
    >
      <form className={s.form} onSubmit={submit}>
        <Field
          label="Domain hoặc URL HTTPS"
          description="Nhập trực tiếp URL (vd: https://infrapulse.hacmieu.com) hoặc domain (vd: github.com)."
          required
        >
          <Input
            aria-label="Domain hoặc URL HTTPS"
            placeholder="https://infrapulse.hacmieu.com"
            value={endpoint}
            required
            maxLength={300}
            onChange={(e) => setEndpoint(e.currentTarget.value)}
          />
        </Field>
        <Field label="Tên hiển thị" description="Để trống sẽ tự lấy theo tên domain.">
          <Input
            aria-label="Tên hiển thị"
            placeholder="InfraPulse Web"
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Field>
        <div className={s.row}>
          <Field label="Port">
            <Input
              aria-label="Port"
              value={portText}
              maxLength={5}
              onChange={(e) => setPortText(e.currentTarget.value)}
            />
          </Field>
          <Field label="Nhóm (Group)">
            <Input
              aria-label="Nhóm"
              placeholder="Production"
              value={group}
              maxLength={64}
              onChange={(e) => setGroup(e.currentTarget.value)}
            />
          </Field>
        </div>
        {validation && (
          <Alert severity="error" title="Kiểm tra lại thông tin">
            {validation}
          </Alert>
        )}
        <ActionState {...action} />
        <Modal.ButtonRow>
          <Button type="button" variant="secondary" disabled={action.pending} onClick={onClose}>
            Hủy
          </Button>
          <Button type="submit" disabled={action.pending}>
            {action.pending ? 'Đang kiểm tra TLS…' : 'Thêm & Kiểm tra ngay'}
          </Button>
        </Modal.ButtonRow>
      </form>
    </Modal>
  );
}

export default function SslTargets() {
  const list = useResource('ssl-targets', api.sslTargets);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SslTarget>();
  const [busyId, setBusyId] = useState<string>();
  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [notice, setNotice] = useState<{ severity: 'error' | 'success'; text: string }>();
  const admin = useAdmin();
  const ui = useStyles2(getSslStyles);
  const sslDash = sslDashboardHref();

  const items = list.data?.items ?? [];

  const stats = useMemo(() => {
    let valid = 0;
    let expiring = 0;
    let critical = 0;
    for (const item of items) {
      if (!item.enabled) continue;
      const d = daysRemaining(item.notAfter);
      if (d === null || d < 0) critical++;
      else if (d < 28) expiring++;
      else valid++;
    }
    return { total: items.length, valid, expiring, critical };
  }, [items]);

  const groups = useMemo(() => [...new Set(items.map((i) => i.group))].sort(), [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (selectedGroup && item.group !== selectedGroup) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.host.toLowerCase().includes(q) ||
        (item.subjectCn ?? '').toLowerCase().includes(q) ||
        (item.issuerCn ?? '').toLowerCase().includes(q)
      );
    });
  }, [items, search, selectedGroup]);

  const handleProbe = async (target: SslTarget) => {
    setBusyId(target.id);
    setNotice(undefined);
    try {
      const res = await api.probeSslTarget(target.id);
      const d = daysRemaining(res.notAfter);
      const expired = d !== null && d < 0;
      setNotice({
        severity: res.lastError || expired ? 'error' : 'success',
        text: expired
          ? `${target.host}:${target.port} — chứng chỉ đã hết hạn (${formatDate(res.notAfter)}).`
          : res.lastError
            ? `${target.host}:${target.port} — lỗi kết nối TLS (${res.lastError}).`
            : `${target.host}:${target.port} — hợp lệ, CN=${res.subjectCn ?? target.host}, hết hạn ${formatDate(res.notAfter)}.`,
      });
      list.retry();
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusyId(undefined);
    }
  };

  const handleToggle = async (target: SslTarget) => {
    setBusyId(target.id);
    setNotice(undefined);
    try {
      await api.updateSslTarget(target.id, { enabled: !target.enabled });
      list.retry();
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <>
      <div className={ui.header}>
        <p className={ui.subtitle}>
          Theo dõi TLS định kỳ 60 giây cho endpoint HTTPS bên ngoài • Chứng chỉ local trên VM tự quét bởi Grafana Alloy.
        </p>
        <div className={ui.actions}>
          {sslDash && (
            <LinkButton variant="secondary" icon="external-link-alt" href={sslDash}>
              Mở Dashboard SSL
            </LinkButton>
          )}
          <Button variant="secondary" icon="sync" onClick={list.retry} disabled={list.loading}>
            Làm mới
          </Button>
          {admin && (
            <Button variant="primary" icon="plus" onClick={() => setShowAdd(true)}>
              Thêm chứng chỉ
            </Button>
          )}
        </div>
      </div>

      <div className={ui.kpiGrid}>
        <div className={ui.kpiCard}>
          <span className={ui.kpiLabel}>Tổng Endpoint</span>
          <span className={ui.kpiValue} style={{ color: '#5794F2' }}>
            {stats.total}
          </span>
        </div>
        <div className={ui.kpiCard}>
          <span className={ui.kpiLabel}>Hợp lệ (&gt; 28 ngày)</span>
          <span className={ui.kpiValue} style={{ color: '#73BF69' }}>
            {stats.valid}
          </span>
        </div>
        <div className={ui.kpiCard}>
          <span className={ui.kpiLabel}>Sắp hết hạn (≤ 28 ngày)</span>
          <span className={ui.kpiValue} style={{ color: stats.expiring > 0 ? '#FF9830' : '#73BF69' }}>
            {stats.expiring}
          </span>
        </div>
        <div className={ui.kpiCard}>
          <span className={ui.kpiLabel}>Hết hạn / Lỗi</span>
          <span className={ui.kpiValue} style={{ color: stats.critical > 0 ? '#F2495C' : '#73BF69' }}>
            {stats.critical}
          </span>
        </div>
      </div>

      {notice && (
        <Alert
          severity={notice.severity}
          title={notice.severity === 'success' ? 'Kiểm tra hoàn tất' : 'Cảnh báo chứng chỉ'}
          onRemove={() => setNotice(undefined)}
        >
          {notice.text}
        </Alert>
      )}

      <div className={ui.toolbar}>
        <div className={ui.searchWrap}>
          <Input
            aria-label="Tìm kiếm chứng chỉ SSL"
            placeholder="Tìm theo tên, domain, CN hoặc Issuer…"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        <div className={ui.groupPills}>
          <button
            type="button"
            className={`${ui.pill} ${selectedGroup === '' ? ui.pillActive : ''}`}
            onClick={() => setSelectedGroup('')}
          >
            Tất cả ({items.length})
          </button>
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              className={`${ui.pill} ${selectedGroup === g ? ui.pillActive : ''}`}
              onClick={() => setSelectedGroup(g)}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      <LoadState {...list} empty={filtered.length === 0}>
        <div className={ui.tableCard}>
          <table className={ui.table}>
            <colgroup>
              <col style={{ width: '27%' }} />
              <col style={{ width: '108px' }} />
              <col />
              <col style={{ width: '152px' }} />
              <col style={{ width: '126px' }} />
              <col style={{ width: '116px' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">Nhóm</th>
                <th scope="col">Chứng chỉ (CN / Issuer)</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Hết hạn</th>
                <th scope="col" className={ui.rightCol}>
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((target) => {
                const endpointText = `${target.host}:${target.port}`;
                return (
                  <tr key={target.id}>
                    <td>
                      <div className={ui.primaryText} title={target.name}>
                        {target.name}
                      </div>
                      <div className={ui.monoSub} title={endpointText}>
                        {endpointText}
                      </div>
                    </td>
                    <td>
                      <span className={ui.groupTag} title={target.group}>
                        {target.group}
                      </span>
                    </td>
                    <td>
                      <div className={ui.primaryText} title={target.subjectCn ?? ''}>
                        {target.subjectCn ?? '—'}
                      </div>
                      <div className={ui.subText} title={target.issuerCn ?? ''}>
                        {target.issuerCn ?? '—'}
                      </div>
                    </td>
                    <td className={ui.badgeCell}>
                      <StatusBadge target={target} />
                    </td>
                    <td>
                      <div className={ui.primaryText}>{formatDate(target.notAfter)}</div>
                      <div className={ui.subText} title={target.lastProbedAt ?? ''}>
                        {formatRelative(target.lastProbedAt)}
                      </div>
                    </td>
                    <td className={ui.rightCol}>
                      <div className={ui.rowActions}>
                        <IconButton
                          name="sync"
                          aria-label={`Kiểm tra ${target.name}`}
                          tooltip="Kiểm tra TLS ngay"
                          disabled={busyId === target.id}
                          onClick={() => void handleProbe(target)}
                        />
                        {admin && (
                          <IconButton
                            name={target.enabled ? 'pause' : 'play'}
                            aria-label={`${target.enabled ? 'Tắt' : 'Bật'} ${target.name}`}
                            tooltip={target.enabled ? 'Tạm tắt giám sát' : 'Bật lại giám sát'}
                            disabled={busyId === target.id}
                            onClick={() => void handleToggle(target)}
                          />
                        )}
                        {admin && (
                          <IconButton
                            name="trash-alt"
                            variant="destructive"
                            aria-label={`Xóa ${target.name}`}
                            tooltip="Xóa endpoint"
                            disabled={busyId === target.id}
                            onClick={() => setDeleteTarget(target)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </LoadState>

      {showAdd && admin && <AddSslTargetModal onClose={() => setShowAdd(false)} onSaved={list.retry} />}
      {deleteTarget && admin && (
        <Confirm
          title={`Xóa chứng chỉ "${deleteTarget.name}" (${deleteTarget.host}:${deleteTarget.port})?`}
          warning="Hệ thống sẽ ngừng kiểm tra TLS cho endpoint này và ngừng gửi metric lên AMP."
          operation={() => api.deleteSslTarget(deleteTarget.id)}
          onDone={list.retry}
          onClose={() => setDeleteTarget(undefined)}
        />
      )}
    </>
  );
}
