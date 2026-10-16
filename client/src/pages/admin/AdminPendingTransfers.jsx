import { useEffect, useState } from 'react';
import { FiRotateCcw } from 'react-icons/fi';
import Badge from '../../components/common/Badge';
import Card from '../../components/common/Card';
import ConfirmModal from '../../components/common/ConfirmModal';
import EmptyState from '../../components/common/EmptyState';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import StatCard from '../../components/common/StatCard';
import { useToast } from '../../context/useToast';
import * as adminApi from '../../services/adminApi';
import { formatCurrency, formatDate } from '../../utils/formatCurrency';
import styles from './AdminDashboard.module.css';

export default function AdminPendingTransfers() {
  const [data, setData] = useState({ transfers: [], summary: { count: 0, total: 0, currency: 'USD' } });
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reversing, setReversing] = useState(false);
  const [error, setError] = useState('');
  const { showToast } = useToast();

  const loadTransfers = async () => {
    setError('');
    try {
      setData(await adminApi.listPendingTransfers());
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not load pending transfers.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTransfers();
  }, []);

  const handleReverse = async () => {
    if (!selectedTransfer) return;
    setReversing(true);
    setError('');
    try {
      await adminApi.reversePendingTransfer(selectedTransfer.id);
      setSelectedTransfer(null);
      showToast('Pending transfer reversed and refunded.', 'success');
      await loadTransfers();
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not reverse this transfer. Refresh and check its status.');
    } finally {
      setReversing(false);
    }
  };

  return (
    <div className="flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Pending transfers" value={data.summary.count} icon={<FiRotateCcw />} />
        <StatCard
          label="Funds held"
          value={formatCurrency(data.summary.total, data.summary.currency)}
          icon={<FiRotateCcw />}
          tone="amber"
        />
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <Card padded={false}>
        {loading ? (
          <LoadingSpinner label="Loading pending transfers" />
        ) : data.transfers.length === 0 ? (
          <EmptyState title="No pending transfers" description="Transfers awaiting review will appear here." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Sender</th>
                  <th>Recipient</th>
                  <th>Reference</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className={styles.right}>Amount</th>
                  <th className={styles.right}>Fee</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map((transfer) => (
                  <tr key={transfer.id}>
                    <td>{transfer.senderName}<br /><span className="mono text-muted">{transfer.senderAccountNumber}</span></td>
                    <td>{transfer.recipientName}<br /><span className="mono text-muted">{transfer.recipientAccountNumber}</span></td>
                    <td className="mono">{transfer.reference}</td>
                    <td>{formatDate(transfer.createdAt)}</td>
                    <td><Badge>{transfer.status}</Badge></td>
                    <td className={`${styles.right} mono`}>{formatCurrency(transfer.amount, transfer.currency)}</td>
                    <td className={`${styles.right} mono`}>{formatCurrency(transfer.fee, transfer.currency)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => setSelectedTransfer(transfer)}
                      >
                        Reverse
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedTransfer && (
        <ConfirmModal
          title="Reverse pending transfer?"
          confirmLabel="Reverse and refund"
          confirmVariant="danger"
          onConfirm={handleReverse}
          onCancel={() => setSelectedTransfer(null)}
          loading={reversing}
        >
          <p>
            This will mark {selectedTransfer.reference} as reversed and refund{' '}
            {formatCurrency(selectedTransfer.amount + selectedTransfer.fee, selectedTransfer.currency)}{' '}
            to {selectedTransfer.senderName}. This cannot be undone.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}