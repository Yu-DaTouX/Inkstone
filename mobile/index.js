// 纯 JS 加密库（经中继连接用）需要 crypto.getRandomValues，必须最先载入。
import 'react-native-get-random-values'
import { AppRegistry } from 'react-native'
import App from './src/App'
import { name as appName } from './app.json'

AppRegistry.registerComponent(appName, () => App)
