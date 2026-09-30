"use strict";
var Reach;
(function (Reach) {
    const memory = new WeakMap();
    function stateFor(ship) {
        let state = memory.get(ship);
        if (!state) {
            state = { wx: 0, wy: 0, wz: 0, vx: 0, vy: 0, vz: 0 };
            memory.set(ship, state);
        }
        return state;
    }
    /** One simulation clock. Debt is bounded; menu/visibility transitions discard it. */
    class FixedClock {
        constructor(step = 1 / 60, maxSteps = 12) {
            this.step = step;
            this.maxSteps = maxSteps;
            this.accumulator = 0;
            this.ticks = 0;
            this.droppedSeconds = 0;
            if (!Number.isFinite(step) || step <= 0 || !Number.isInteger(maxSteps) || maxSteps < 1)
                throw new Error('Invalid simulation clock configuration.');
        }
        get alpha() { return Reach.clamp(this.accumulator / this.step, 0, 1); }
        reset() { this.accumulator = 0; }
        advance(seconds, simulate) {
            if (!Number.isFinite(seconds) || seconds <= 0)
                return 0;
            const capacity = this.step * this.maxSteps;
            const accepted = Math.min(seconds, capacity);
            this.droppedSeconds += seconds - accepted;
            this.accumulator += accepted;
            let count = 0;
            while (this.accumulator + 1e-10 >= this.step && count < this.maxSteps) {
                this.accumulator = Math.max(0, this.accumulator - this.step);
                ++count;
                ++this.ticks;
                if (!simulate(this.step)) {
                    this.reset();
                    break;
                }
            }
            return count;
        }
    }
    Reach.FixedClock = FixedClock;
    /** Pooled authoritative samples; presentation never writes into the physics state. */
    class PoseTrack {
        constructor(pose) {
            this.before = new Float64Array(7);
            this.after = new Float64Array(7);
            this.rendered = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
            this.reset(pose);
        }
        write(target, pose) {
            target[0] = pose.x;
            target[1] = pose.y;
            target[2] = pose.z;
            target[3] = pose.qx;
            target[4] = pose.qy;
            target[5] = pose.qz;
            target[6] = pose.qw;
        }
        reset(pose) { this.write(this.before, pose); this.write(this.after, pose); this.sample(1); }
        capture(pose) { this.before.set(this.after); this.write(this.after, pose); }
        sample(alpha) {
            const t = Reach.clamp(alpha, 0, 1), a = this.before, b = this.after, p = this.rendered;
            p.x = a[0] + (b[0] - a[0]) * t;
            p.y = a[1] + (b[1] - a[1]) * t;
            p.z = a[2] + (b[2] - a[2]) * t;
            // Hemisphere-correct SLERP avoids the q / -q discontinuity at a half turn.
            let dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
            const sign = dot < 0 ? -1 : 1;
            dot = Math.abs(dot);
            let wa = 1 - t, wb = t;
            if (dot < 0.9995) {
                const angle = Math.acos(Reach.clamp(dot, 0, 1));
                const divisor = Math.sin(angle);
                wa = Math.sin((1 - t) * angle) / divisor;
                wb = Math.sin(t * angle) / divisor;
            }
            p.qx = a[3] * wa + b[3] * wb * sign;
            p.qy = a[4] * wa + b[4] * wb * sign;
            p.qz = a[5] * wa + b[5] * wb * sign;
            p.qw = a[6] * wa + b[6] * wb * sign;
            const length = Math.hypot(p.qx, p.qy, p.qz, p.qw) || 1;
            p.qx /= length;
            p.qy /= length;
            p.qz /= length;
            p.qw /= length;
            return p;
        }
    }
    Reach.PoseTrack = PoseTrack;
    function velocityServo(out, vx, vy, vz, tx, ty, tz, acceleration, dt) {
        const dx = tx - vx, dy = ty - vy, dz = tz - vz;
        const error = Math.hypot(dx, dy, dz);
        const fraction = Math.min(1 - Math.exp(-5 * dt), acceleration * dt / Math.max(1e-9, error));
        out.vx = vx + dx * fraction;
        out.vy = vy + dy * fraction;
        out.vz = vz + dz * fraction;
    }
    function solve(ship, intent, dt, velocity) {
        const out = stateFor(ship), hull = SE.stats(ship);
        const fx = -2 * (ship.qw * ship.qy + ship.qz * ship.qx);
        const fy = 2 * (ship.qw * ship.qx - ship.qz * ship.qy);
        const fz = 2 * (ship.qx * ship.qx + ship.qy * ship.qy) - 1;
        let dx = intent.sx - ship.x, dy = intent.sy - ship.y, dz = intent.sz - ship.z;
        const distance = Math.hypot(dx, dy, dz), moving = !intent.brake && intent.throttle > 0;
        const maxRate = hull.torque / Math.sqrt(hull.mass) * 0.30;
        let wx = 0, wy = 0, wz = 0, align = 0;
        if (moving && distance > 1e-6) {
            dx /= distance;
            dy /= distance;
            dz /= distance;
            align = Reach.clamp(fx * dx + fy * dy + fz * dz, -1, 1);
            let ax = fy * dz - fz * dy, ay = fz * dx - fx * dz, az = fx * dy - fy * dx;
            let axis = Math.hypot(ax, ay, az);
            if (axis < 1e-7 && align < 0) {
                // Choose a perpendicular axis even when the nose points vertically.
                ax = Math.abs(fy) < 0.9 ? -fz : 0;
                ay = Math.abs(fy) < 0.9 ? 0 : fz;
                az = Math.abs(fy) < 0.9 ? fx : -fy;
                axis = Math.hypot(ax, ay, az);
            }
            if (axis > 1e-7) {
                const rate = Math.min(maxRate, Math.acos(align) * 2.8);
                wx = ax / axis * rate;
                wy = ay / axis * rate;
                wz = az / axis * rate;
            }
        }
        // Nose alignment alone leaves roll unconstrained. Transporting successive
        // pitch/yaw turns then accumulates bank, even after the route straightens.
        // Correct twist about forward independently, fading near the world-up pole.
        const ux = 2 * (ship.qx * ship.qy - ship.qw * ship.qz);
        const uy = 1 - 2 * (ship.qx * ship.qx + ship.qz * ship.qz);
        const uz = 2 * (ship.qy * ship.qz + ship.qw * ship.qx);
        const horizon = Math.sqrt(Math.max(0, 1 - fy * fy));
        if (horizon > 0.04) {
            const dxUp = -fy * fx / horizon, dyUp = (1 - fy * fy) / horizon, dzUp = -fy * fz / horizon;
            const sine = fx * (uy * dzUp - uz * dyUp) + fy * (uz * dxUp - ux * dzUp) + fz * (ux * dyUp - uy * dxUp);
            const cosine = ux * dxUp + uy * dyUp + uz * dzUp;
            const rate = Reach.clamp(Math.atan2(sine, cosine) * 1.8, -Math.min(maxRate, 0.8), Math.min(maxRate, 0.8)) * Reach.clamp((horizon - 0.04) / 0.2, 0, 1);
            wx += fx * rate;
            wy += fy * rate;
            wz += fz * rate;
            const angularMagnitude = Math.hypot(wx, wy, wz), limit = Math.min(1, maxRate / Math.max(1e-9, angularMagnitude));
            wx *= limit;
            wy *= limit;
            wz *= limit;
        }
        // Angular acceleration is bounded for both steering and horizon correction.
        const angularError = Math.hypot(wx - out.wx, wy - out.wy, wz - out.wz);
        const angularStep = Math.min(1 - Math.exp(-14 * dt), maxRate * 7 * dt / Math.max(1e-9, angularError));
        out.wx += (wx - out.wx) * angularStep;
        out.wy += (wy - out.wy) * angularStep;
        out.wz += (wz - out.wz) * angularStep;
        const acceleration = hull.thrust / hull.mass;
        let tx = 0, ty = 0, tz = 0;
        if (moving) {
            const remaining = Math.max(0, distance - intent.stopRadius);
            // A stopping-distance envelope prevents arrival overshoot; the linear
            // term damps the last few metres instead of toggling an arrival switch.
            const relativeSpeed = Math.min(hull.topSpeed * intent.throttle, Math.sqrt(2 * acceleration * 0.72 * remaining), remaining);
            const speed = relativeSpeed * Math.max(0, align);
            tx = (intent.tvx || 0) + dx * speed;
            ty = (intent.tvy || 0) + dy * speed;
            tz = (intent.tvz || 0) + dz * speed;
            const total = Math.hypot(tx, ty, tz), cap = Math.min(1, hull.topSpeed / Math.max(1e-9, total));
            tx *= cap;
            ty *= cap;
            tz *= cap;
        }
        velocityServo(out, velocity.x, velocity.y, velocity.z, tx, ty, tz, acceleration, dt);
        return out;
    }
    Reach.Motion = {
        reset(ship) { memory.delete(ship); },
        steer(ship, intent, dt, body) {
            const out = solve(ship, intent, dt, body.velocity);
            body.setAngularVelocity(out.wx, out.wy, out.wz);
            body.setVelocity(out.vx, out.vy, out.vz);
        },
        drive(ship, body, fx, fy, fz, speed, dt, boost) {
            const out = stateFor(ship), velocity = body.velocity, hull = SE.stats(ship);
            velocityServo(out, velocity.x, velocity.y, velocity.z, fx * speed, fy * speed, fz * speed, hull.thrust / hull.mass * boost, dt);
            body.setVelocity(out.vx, out.vy, out.vz);
        },
        abstract(ship, intent, dt) {
            const vx = ship.vx, vy = ship.vy, vz = ship.vz;
            const out = solve(ship, intent, dt, { x: vx, y: vy, z: vz });
            const omega = Math.hypot(out.wx, out.wy, out.wz), scale = omega > 1e-9 ? Math.sin(omega * dt * 0.5) / omega : dt * 0.5;
            const x = out.wx * scale, y = out.wy * scale, z = out.wz * scale, w = Math.cos(omega * dt * 0.5);
            const qx = ship.qx, qy = ship.qy, qz = ship.qz, qw = ship.qw;
            ship.qx = w * qx + x * qw + y * qz - z * qy;
            ship.qy = w * qy - x * qz + y * qw + z * qx;
            ship.qz = w * qz + x * qy - y * qx + z * qw;
            ship.qw = w * qw - x * qx - y * qy - z * qz;
            const norm = Math.hypot(ship.qx, ship.qy, ship.qz, ship.qw) || 1;
            ship.qx /= norm;
            ship.qy /= norm;
            ship.qz /= norm;
            ship.qw /= norm;
            ship.vx = out.vx;
            ship.vy = out.vy;
            ship.vz = out.vz;
            ship.x += (vx + ship.vx) * 0.5 * dt;
            ship.y += (vy + ship.vy) * 0.5 * dt;
            ship.z += (vz + ship.vz) * 0.5 * dt;
        }
    };
})(Reach || (Reach = {}));
Object.assign(SE, { FixedClock: Reach.FixedClock, PoseTrack: Reach.PoseTrack, Motion: Reach.Motion });
