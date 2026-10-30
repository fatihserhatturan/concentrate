import React from 'react';
import { Button } from './Button';

export class Legacy extends React.Component {
  render() {
    return this.props.ready ? <Button label="Go" onClick={this.props.onGo} /> : null;
  }
}
