import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ToastProvider } from './components/Toast'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('AMRIT renderer root was not found.')

createRoot(root).render(<StrictMode><ToastProvider><App /></ToastProvider></StrictMode>)

