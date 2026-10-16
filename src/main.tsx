import { createRoot } from 'react-dom/client';
import PixelGate from './App';
import './styles.css';
import { applyTheme, readTheme } from './theme';

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<PixelGate />);
