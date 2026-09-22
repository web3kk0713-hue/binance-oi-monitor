import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const element = document.getElementById('root');
if (!element) throw new Error('应用根元素不存在。');
createRoot(element).render(<StrictMode><App /></StrictMode>);
