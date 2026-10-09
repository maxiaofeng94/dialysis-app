import { createApp } from 'vue'
import Vant from 'vant'
import 'vant/lib/index.css'
import App from './App.vue'
import router from './router'
import './style.css'
// 必须放在 vant 的 CSS 之后：它用 CSS 变量接管图标字体族，指向本地字体文件
import './styles/vant-icon-font.css'

const app = createApp(App)
app.use(router)
app.use(Vant)
app.mount('#app')
