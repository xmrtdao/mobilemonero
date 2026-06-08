import {Composition} from 'remotion';
import {XMRTExplainer} from './XMRTExplainer';

export const RemotionRoot = () => {
	return (
		<>
			<Composition
				id="XMRT-Explainer"
				component={XMRTExplainer}
				durationInFrames={900}
				fps={30}
				width={1920}
				height={1080}
				defaultProps={{
					title: 'XMRT DAO',
					tagline: 'Hoist the Colors, Captain',
				}}
			/>
		</>
	);
};
