import {View} from 'gpui-kit';
import * as herdr from 'herdr';
import {LaunchDialog} from '../../shared/launch-dialog.js';

export default class MissionControlAgentMenu extends View {
  init(_props,cx){this.dialog=new LaunchDialog('mission-control-agent-menu',herdr.props()||{},herdr);this.dialog.init(cx);}
  render(cx){return this.dialog.render(cx);}
  close(){this.dialog.close();}
}
