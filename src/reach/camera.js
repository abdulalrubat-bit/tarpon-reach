"use strict";
var Reach;
(function (Reach) {
    /** Presentation-only rig: orbit gestures cannot issue ship orders or write a physics pose. */
    class OrbitCamera {
        constructor() {
            this.mode = 'follow';
            this.ready = false;
            this.yaw = 0;
            this.pitch = 0.24;
            this.targetYaw = 0;
            this.targetPitch = 0.24;
            this.zoomFactor = 1;
            this.targetZoom = 1;
            this.bearing = 0;
            this.frame = { position: { x: 0, y: 0, z: 0 }, aim: { x: 0, y: 0, z: 0 } };
        }
        get distanceScale() { return this.targetZoom; }
        beginOrbit() {
            if (this.mode === 'orbit')
                return;
            this.mode = 'orbit';
            this.targetYaw = this.yaw;
            this.targetPitch = this.pitch;
        }
        orbit(dx, dy, span) {
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(span))
                return;
            this.beginOrbit();
            const sensitivity = Math.PI * 1.5 / Math.max(240, span);
            this.targetYaw = this.wrap(this.targetYaw - dx * sensitivity);
            this.targetPitch = Reach.clamp(this.targetPitch + dy * sensitivity, -1.32, 1.32);
        }
        zoom(factor) { if (Number.isFinite(factor) && factor > 0)
            this.targetZoom = Reach.clamp(this.targetZoom * factor, 0.60, 6); }
        recenter() { this.mode = 'follow'; this.targetPitch = 0.24; }
        wrap(angle) { return Math.atan2(Math.sin(angle), Math.cos(angle)); }
        update(pose, radius, speed, dt) {
            const fx = -2 * (pose.qw * pose.qy + pose.qz * pose.qx), fz = 2 * (pose.qx * pose.qx + pose.qy * pose.qy) - 1;
            // Retain the last bearing near vertical flight; atan2 noise must not flip the camera.
            if (Math.hypot(fx, fz) > 0.12)
                this.bearing = Math.atan2(-fx, -fz);
            if (this.mode === 'follow')
                this.targetYaw = this.bearing;
            const seconds = Number.isFinite(dt) ? Reach.clamp(dt, 0, 0.2) : 0;
            const response = 1 - Math.exp(-12 * seconds);
            if (!this.ready) {
                this.yaw = this.targetYaw;
                this.pitch = this.targetPitch;
                this.zoomFactor = this.targetZoom;
                this.ready = true;
            }
            else {
                this.yaw = this.wrap(this.yaw + this.wrap(this.targetYaw - this.yaw) * response);
                this.pitch += (this.targetPitch - this.pitch) * response;
                this.zoomFactor += (this.targetZoom - this.zoomFactor) * response;
            }
            const distance = Math.max(36, radius * 3.2) * this.zoomFactor * (1 + Math.min(0.15, Math.max(0, speed) / 600));
            const horizontal = Math.cos(this.pitch) * distance;
            const { position, aim } = this.frame;
            aim.x = pose.x;
            aim.y = pose.y + radius * 0.12;
            aim.z = pose.z;
            // Follow the interpolated ship exactly; smoothing absolute world positions adds frame-rate-dependent chase lag.
            position.x = aim.x + Math.sin(this.yaw) * horizontal;
            position.y = aim.y + Math.sin(this.pitch) * distance;
            position.z = aim.z + Math.cos(this.yaw) * horizontal;
            return this.frame;
        }
    }
    Reach.OrbitCamera = OrbitCamera;
})(Reach || (Reach = {}));
Object.assign(SE, { OrbitCamera: Reach.OrbitCamera });
