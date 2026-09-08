import { useState } from 'react';

export const MOCK_DEALERS = [
  { id: '1', name: 'BMW Infinity Cars', location: 'Worli', tel: '+91 22 67145100', url: 'www.bmw-infinitycars.in' },
  { id: '2', name: 'BMW Navnit Motors', location: 'Andheri', tel: '+91 22 66777777', url: 'www.bmw-navnitmotors-mumbai.in' },
  { id: '3', name: 'BMW Infinity Cars', location: 'Nariman Point', tel: '+91 22 66664800', url: 'www.bmw-infinitycars.in' },
  { id: '4', name: 'BMW Infinity Cars', location: 'Navi Mumbai', tel: '+91 22 69009000', url: 'www.bmw-infinitycars.in' },
  { id: '5', name: 'BMW Navnit Motors', location: 'Malad', tel: '+91 22 66772222', url: 'www.bmw-navnitmotors-mumbai.in' }
];

export function DealersDatabase({ onSelect }: { onSelect: (selected: string[]) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const toggleDealer = (id: string) => {
    const next = selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id];
    setSelectedIds(next);
    onSelect(next);
  };

  return (
    <div className="dealers-database glass-panel" style={{ marginTop: '24px' }}>
      <h3>BMW Dealers Database</h3>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Select dealers to generate artwork for.</p>
      
      <div className="dealer-list" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '16px' }}>
        {MOCK_DEALERS.map(dealer => (
          <div 
            key={dealer.id} 
            className={`dealer-card ${selectedIds.includes(dealer.id) ? 'selected' : ''}`}
            onClick={() => toggleDealer(dealer.id)}
            style={{ 
              padding: '12px', 
              border: `1px solid ${selectedIds.includes(dealer.id) ? 'var(--bmw-blue)' : 'var(--glass-border)'}`,
              borderRadius: '8px',
              cursor: 'pointer',
              backgroundColor: selectedIds.includes(dealer.id) ? 'rgba(0,102,177,0.1)' : 'transparent',
              transition: 'all 0.2s'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <strong>{dealer.name}</strong>
              <input type="checkbox" checked={selectedIds.includes(dealer.id)} readOnly />
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              <div>{dealer.location}</div>
              <div>Tel: {dealer.tel}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
