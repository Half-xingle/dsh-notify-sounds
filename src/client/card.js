/** Inline styles keyed to the app's design tokens. */
const cardStyle = {
	card: {
		boxSizing: "border-box",
		border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
		background: "var(--dsw-alias-settings-card-fill)",
		borderRadius: "var(--dsw-radius-xl)",
		listStyle: "none",
		padding: "12px 16px 14px",
		display: "flex",
		flexDirection: "column",
		gap: "10px",
	},
};

/** Render the notify-sounds settings card. */
function NotifyCard(props) {
	return react.createElement("li", { style: cardStyle.card }, props.t("title"));
}
